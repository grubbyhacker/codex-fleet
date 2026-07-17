import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  CanonicalJournalReducer,
  ContinuationBudgetAccount,
  LegacyAgentdV1JournalReader,
  LegacyDeferredVerifierAdapter,
  SESSION_JOURNAL_VERSION,
  canonicalJournalRecordSchema,
  canonicalValueDigest,
  journalMigrationBundleSchema,
  migrateLegacyAgentdV1Journal
} from "@grubbyhacker/session-supervisor";

const session = {
  version: "agentd/v1",
  sessionId: "session-1",
  coordinatorBinding: "coordinator",
  authorityBinding: "authority",
  workerId: "worker-a",
  storageLineageId: "storage-a",
  fenceEpoch: 1,
  sessionLineageId: "lineage-a",
  workspace: { workspaceRef: "workspace", uid: 20001, gid: 20001 },
  phase: "active",
  turnIds: ["turn-1"],
  nextCursor: 1
} as const;

const queuedTurn = {
  turnId: "turn-1",
  sessionId: session.sessionId,
  prompt: "perform registered work",
  idempotencyKey: "turn-key",
  phase: "queued",
  attemptIds: [],
  recoveryFacts: [],
  continuationDepth: 0,
  tokenUsage: {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  }
} as const;

function legacyRow(cursor: number, event: Record<string, unknown>) {
  const eventJson = JSON.stringify(event);
  return {
    cursor,
    protocol_version: "agentd/v1",
    event_json: eventJson,
    event_digest: createHash("sha256").update(eventJson).digest("hex"),
    recorded_at: "2026-07-17T00:00:00.000Z"
  };
}

function fixtureRows() {
  const runningTurn = {
    ...queuedTurn,
    phase: "running",
    attemptIds: ["attempt-1"]
  };
  const completedTurn = {
    ...runningTurn,
    phase: "completed",
    verifierState: "satisfied",
    tokenUsage: {
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningOutputTokens: 1,
      totalTokens: 15
    }
  };
  return [
    legacyRow(1, {
      version: "agentd/v1",
      kind: "session_created",
      sessionId: session.sessionId,
      payload: { session }
    }),
    legacyRow(2, {
      version: "agentd/v1",
      kind: "turn_enqueued",
      sessionId: session.sessionId,
      turnId: queuedTurn.turnId,
      payload: { turn: queuedTurn }
    }),
    legacyRow(3, {
      version: "agentd/v1",
      kind: "attempt_started",
      sessionId: session.sessionId,
      turnId: queuedTurn.turnId,
      attemptId: "attempt-1",
      payload: { turn: runningTurn }
    }),
    legacyRow(4, {
      version: "agentd/v1",
      kind: "attempt_completed",
      sessionId: session.sessionId,
      turnId: queuedTurn.turnId,
      attemptId: "attempt-1",
      payload: {
        conversation: {
          adapterKind: "codex",
          adapterVersion: "1",
          backendThreadRef: "thread-1"
        },
        tokenUsage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 15
        }
      }
    }),
    legacyRow(5, {
      version: "agentd/v1",
      kind: "verifier_evaluated",
      sessionId: session.sessionId,
      turnId: queuedTurn.turnId,
      attemptId: "attempt-1",
      payload: { turn: completedTurn, outcome: "satisfied", facts: ["legacy-check"] }
    }),
    legacyRow(6, {
      version: "agentd/v1",
      kind: "turn_finished",
      sessionId: session.sessionId,
      turnId: queuedTurn.turnId,
      attemptId: "attempt-1",
      payload: { turn: completedTurn }
    })
  ];
}

describe("behavioral journal compatibility", () => {
  test("strictly reads immutable legacy rows and rejects tampering and future versions", () => {
    const reader = new LegacyAgentdV1JournalReader();
    expect(reader.read(fixtureRows())).toHaveLength(6);

    const tampered = fixtureRows();
    tampered[1] = { ...tampered[1]!, event_json: "{}" };
    expect(() => reader.read(tampered)).toThrow("legacy journal digest mismatch");

    const future = fixtureRows();
    future[0] = { ...future[0]!, protocol_version: "agentd/v9" as "agentd/v1" };
    expect(() => reader.read(future)).toThrow();
  });

  test("migrates deterministically to canonical snapshots and reconciles unregistered success", () => {
    const source = new LegacyAgentdV1JournalReader().read(fixtureRows());
    const first = migrateLegacyAgentdV1Journal(source);
    const replay = migrateLegacyAgentdV1Journal(source);

    expect(replay).toEqual(first);
    expect(first.manifest).toMatchObject({
      sourceProtocolVersion: "agentd/v1",
      sourceRowCount: 6,
      targetJournalVersion: SESSION_JOURNAL_VERSION,
      targetRowCount: 7
    });
    expect(first.records.map((record) => record.cursor)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.stringify(first.records)).not.toContain("legacy-check");

    const finalRecord = first.records.at(-1);
    expect(finalRecord?.event.kind).toBe("state_imported");
    if (finalRecord?.event.kind !== "state_imported") throw new Error("missing imported state");
    expect(finalRecord.event.payload.turns).toContainEqual(
      expect.objectContaining({
        turnId: "turn-1",
        phase: "reconciliation",
        tokenUsage: expect.objectContaining({ totalTokens: 15 }),
        recoveryFacts: ["legacy_unregistered_verifier_requires_reconciliation"]
      })
    );
    expect(finalRecord.event.payload.facts).toContain("legacy_unregistered_verifier");
  });

  test("detects a changed target bundle and forbids using the deferred adapter for new work", () => {
    const bundle = migrateLegacyAgentdV1Journal(
      new LegacyAgentdV1JournalReader().read(fixtureRows())
    );
    const changed = structuredClone(bundle);
    changed.records[0]!.transactionId = "changed";
    expect(() => journalMigrationBundleSchema.parse(changed)).toThrow(
      "migration target digest mismatch"
    );

    expect(() => new LegacyDeferredVerifierAdapter().verify()).toThrow("cannot evaluate new work");
  });

  test("marks an authorized but unresolved legacy invocation for reconciliation", () => {
    const rows = fixtureRows().slice(0, 3);
    const bundle = migrateLegacyAgentdV1Journal(new LegacyAgentdV1JournalReader().read(rows));
    const finalRecord = bundle.records.at(-1);
    expect(finalRecord?.event.kind).toBe("state_imported");
    if (finalRecord?.event.kind !== "state_imported") throw new Error("missing imported state");
    expect(finalRecord.event.payload.turns[0]).toMatchObject({
      phase: "reconciliation",
      recoveryFacts: ["interrupted_attempt_requires_reconciliation"]
    });
    expect(finalRecord.event.payload.facts).toContain(
      "interrupted_attempt_requires_reconciliation"
    );
  });

  test("rejects effect authorization that could bypass reservation or conservative cleanup", () => {
    const base = {
      version: SESSION_JOURNAL_VERSION,
      cursor: 1,
      transactionId: "transaction-1",
      sessionId: "session-1"
    } as const;
    expect(() =>
      canonicalJournalRecordSchema.parse({
        ...base,
        event: {
          kind: "effect_authorized",
          payload: {
            effectId: "effect-1",
            effectKind: "model_turn",
            idempotencyKey: "model-1",
            targetRef: "runtime"
          }
        }
      })
    ).toThrow("model turn authorization requires a budget reservation");
    expect(() =>
      canonicalJournalRecordSchema.parse({
        ...base,
        event: {
          kind: "janitor_planned",
          payload: {
            planId: "plan-1",
            repositoryRef: "repository",
            exactTargets: [],
            classification: "clean_disposable"
          }
        }
      })
    ).toThrow();
  });

  test("replays new runtime state from canonical records alone and rejects late completion", () => {
    const policy = {
      maxContinuations: 1,
      maxModelTurns: 2,
      wallClockDeadlineMs: 60_000,
      maxTotalTokens: 100,
      maxRuntimeMs: 10_000,
      perTurnTimeoutMs: 8_000
    } as const;
    const task = {
      taskKind: "repository_change_v1",
      completionContract: "repository_state_v1",
      verifierId: "repository_state_v1",
      contractDigest: `sha256:${"a".repeat(64)}`,
      parameters: { repositoryId: "neutral" },
      taskEvidenceDigest: `sha256:${"b".repeat(64)}`,
      budget: policy
    };
    const budget = new ContinuationBudgetAccount(policy, 1_000);
    const reservation = budget.reserveTurn("session-1", "model-1", 0, 1_100);
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 15,
      runtimeMs: 250
    };
    const usageEvent = budget.recordUsage("session-1", "attempt-1", {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: usage.totalTokens,
      runtimeMs: usage.runtimeMs
    });
    const budgetDecision = budget.decideCompletion("session-1", 2_000);
    const verifierResult = {
      outcome: "missing_or_stale" as const,
      contractDigest: task.contractDigest,
      taskEvidenceDigest: task.taskEvidenceDigest,
      headRevision: "head-1",
      reasons: [
        { code: "policy_mismatch", evidenceRef: "evidence-1" },
        { code: "missing_required_state", evidenceRef: "evidence-1" },
        { code: "policy_mismatch", evidenceRef: "evidence-1" }
      ],
      evidenceRefs: ["evidence-1"]
    };
    const continuationReservation = budget.reserveTurn("session-1", "continuation-1", 1, 2_100);
    const continuationInput = {
      taskKind: task.taskKind,
      completionContract: task.completionContract,
      contractDigest: task.contractDigest,
      taskEvidenceDigest: task.taskEvidenceDigest,
      parentTurnId: "turn-1",
      continuationDepth: 1,
      reasonCodes: ["missing_required_state", "policy_mismatch"]
    };
    const records = [
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 1,
        transactionId: "open-1",
        sessionId: "session-1",
        event: {
          kind: "session_opened",
          payload: {
            coordinatorBinding: "coordinator",
            authorityBinding: "authority",
            workerBinding: "worker-1",
            storageLineageId: "1".repeat(32),
            fenceEpoch: 1,
            sessionLineageId: "2".repeat(32),
            authorityProfile: "general-writer-v1",
            authorityProfileVersion: "1",
            policyDigest: "f".repeat(64),
            workspace: { workspaceRef: "workspace-1", uid: 20000, gid: 20000 }
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 2,
        transactionId: "authorize-1",
        sessionId: "session-1",
        event: {
          kind: "effect_authorized",
          payload: {
            effectId: "attempt-1",
            effectKind: "model_turn",
            idempotencyKey: "model-1",
            targetRef: "registered-input-1",
            turnId: "turn-1",
            fenceEpoch: 1,
            task,
            budgetEvent: reservation
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 3,
        transactionId: "complete-1",
        sessionId: "session-1",
        event: {
          kind: "effect_completed",
          payload: {
            effectId: "attempt-1",
            resultDigest: "c".repeat(64),
            resultRef: "result-1",
            conversation: {
              adapterKind: "codex",
              adapterVersion: "0.144.5",
              backendThreadRef: "thread-1"
            },
            usage,
            budgetEvent: usageEvent
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 4,
        transactionId: "verify-authorize-1",
        sessionId: "session-1",
        event: {
          kind: "effect_authorized",
          payload: {
            effectId: "verifier-1",
            effectKind: "verifier",
            idempotencyKey: "verifier-1",
            targetRef: "repository-state-1",
            turnId: "turn-1",
            fenceEpoch: 1,
            task
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 5,
        transactionId: "verify-complete-1",
        sessionId: "session-1",
        event: {
          kind: "effect_completed",
          payload: {
            effectId: "verifier-1",
            resultDigest: canonicalValueDigest(verifierResult),
            resultRef: "verifier-result-1"
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 6,
        transactionId: "completion-1",
        sessionId: "session-1",
        event: {
          kind: "completion_decided",
          payload: { turnId: "turn-1", task, verifierResult, budgetDecision, decidedAtMs: 2_000 }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 7,
        transactionId: "continuation-1",
        sessionId: "session-1",
        event: {
          kind: "continuation_linked",
          payload: {
            sourceTurnId: "turn-1",
            continuationTurnId: "turn-2",
            input: continuationInput,
            reservation: continuationReservation
          }
        }
      }
    ].map((record) => canonicalJournalRecordSchema.parse(record));

    const missingUsage = new CanonicalJournalReducer();
    missingUsage.apply(records[0]!);
    missingUsage.apply(records[1]!);
    expect(() =>
      missingUsage.apply(
        canonicalJournalRecordSchema.parse({
          version: SESSION_JOURNAL_VERSION,
          cursor: 3,
          transactionId: "missing-usage",
          sessionId: "session-1",
          event: {
            kind: "effect_completed",
            payload: { effectId: "attempt-1", resultDigest: "e".repeat(64) }
          }
        })
      )
    ).toThrow("requires exact atomic usage");

    const fabricatedReservation = structuredClone(records[1]!);
    if (
      fabricatedReservation.event.kind !== "effect_authorized" ||
      fabricatedReservation.event.payload.budgetEvent?.kind !== "budget_reserved"
    )
      throw new Error("missing reservation fixture");
    fabricatedReservation.event.payload.budgetEvent.snapshot.totalTokens = 1;
    const fabricated = new CanonicalJournalReducer();
    fabricated.apply(records[0]!);
    expect(() => fabricated.apply(fabricatedReservation)).toThrow(
      "conflicts with cumulative budget state"
    );

    const crossSessionBudget = structuredClone(records[1]!);
    if (
      crossSessionBudget.event.kind !== "effect_authorized" ||
      crossSessionBudget.event.payload.budgetEvent?.kind !== "budget_reserved"
    )
      throw new Error("missing reservation fixture");
    crossSessionBudget.event.payload.budgetEvent.sessionId = "session-2";
    expect(() => canonicalJournalRecordSchema.parse(crossSessionBudget)).toThrow(
      "effect budget belongs to another session"
    );

    const verifierBypass = new CanonicalJournalReducer();
    records.slice(0, 3).forEach((record) => verifierBypass.apply(record));
    expect(() =>
      verifierBypass.apply(
        canonicalJournalRecordSchema.parse({
          ...records[5],
          cursor: 4,
          transactionId: "verifier-bypass"
        })
      )
    ).toThrow("completed registered verifier effect");

    const invalidContinuation = structuredClone(records[6]!);
    if (invalidContinuation.event.kind !== "continuation_linked")
      throw new Error("missing continuation fixture");
    invalidContinuation.event.payload.input.parentTurnId = "unrelated-turn";
    const lineage = new CanonicalJournalReducer();
    records.slice(0, 6).forEach((record) => lineage.apply(record));
    expect(() => lineage.apply(invalidContinuation)).toThrow(
      "lineage conflicts with its reservation"
    );
    const invalidReasons = structuredClone(records[6]!);
    if (invalidReasons.event.kind !== "continuation_linked")
      throw new Error("missing continuation fixture");
    invalidReasons.event.payload.input.reasonCodes = ["fabricated_reason"];
    const reasonBinding = new CanonicalJournalReducer();
    records.slice(0, 6).forEach((record) => reasonBinding.apply(record));
    expect(() => reasonBinding.apply(invalidReasons)).toThrow(
      "reason codes conflict with the verifier decision"
    );

    const continuationUsage = {
      inputTokens: 4,
      cachedInputTokens: 1,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 6,
      runtimeMs: 100
    };
    const continuationUsageEvent = budget.recordUsage("session-1", "attempt-2", continuationUsage);
    const continuationResult = {
      outcome: "satisfied" as const,
      contractDigest: task.contractDigest,
      taskEvidenceDigest: task.taskEvidenceDigest,
      headRevision: "head-2",
      reasons: [],
      evidenceRefs: ["evidence-2"]
    };
    const continued = new CanonicalJournalReducer();
    records.forEach((record) => continued.apply(record));
    [
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 8,
        transactionId: "authorize-2",
        sessionId: "session-1",
        event: {
          kind: "effect_authorized",
          payload: {
            effectId: "attempt-2",
            effectKind: "model_turn",
            idempotencyKey: "continuation-1",
            targetRef: "registered-input-2",
            turnId: "turn-2",
            parentTurnId: "turn-1",
            fenceEpoch: 1,
            task,
            budgetEvent: continuationReservation
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 9,
        transactionId: "complete-2",
        sessionId: "session-1",
        event: {
          kind: "effect_completed",
          payload: {
            effectId: "attempt-2",
            resultDigest: "8".repeat(64),
            usage: continuationUsage,
            budgetEvent: continuationUsageEvent
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 10,
        transactionId: "verify-2",
        sessionId: "session-1",
        event: {
          kind: "effect_authorized",
          payload: {
            effectId: "verifier-2",
            effectKind: "verifier",
            idempotencyKey: "verifier-2",
            targetRef: "repository-state-2",
            turnId: "turn-2",
            fenceEpoch: 1,
            task
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 11,
        transactionId: "verify-complete-2",
        sessionId: "session-1",
        event: {
          kind: "effect_completed",
          payload: {
            effectId: "verifier-2",
            resultDigest: canonicalValueDigest(continuationResult)
          }
        }
      },
      {
        version: SESSION_JOURNAL_VERSION,
        cursor: 12,
        transactionId: "completion-2",
        sessionId: "session-1",
        event: {
          kind: "completion_decided",
          payload: {
            turnId: "turn-2",
            task,
            verifierResult: continuationResult,
            budgetDecision: budget.decideCompletion("session-1", 2_500),
            decidedAtMs: 2_500
          }
        }
      }
    ]
      .map((record) => canonicalJournalRecordSchema.parse(record))
      .forEach((record) => continued.apply(record));
    expect(continued.snapshot().sessions["session-1"]?.completionDecisions).toHaveLength(2);

    const fenced = new CanonicalJournalReducer();
    fenced.apply(records[0]!);
    fenced.apply(records[1]!);
    fenced.apply(
      canonicalJournalRecordSchema.parse({
        version: SESSION_JOURNAL_VERSION,
        cursor: 3,
        transactionId: "adopt-1",
        sessionId: "session-1",
        event: {
          kind: "session_adopted",
          payload: {
            kind: "session_reassigned",
            fingerprint: {
              logicalSessionId: "session-1",
              sessionLineage: "2".repeat(32),
              authorityProfile: "general-writer-v1",
              authorityProfileVersion: "1",
              policyDigest: "f".repeat(64),
              storageLineage: "1".repeat(32),
              predecessorWorker: "worker-1",
              predecessorEpoch: 1,
              successorWorker: "worker-2",
              successorEpoch: 2,
              idempotencyKey: "adopt-1"
            },
            predecessor: {
              logicalSessionId: "session-1",
              sessionLineage: "2".repeat(32),
              authorityProfile: "general-writer-v1",
              authorityProfileVersion: "1",
              policyDigest: "f".repeat(64),
              storageLineage: "1".repeat(32),
              workerBinding: "worker-1",
              fenceEpoch: 1
            },
            successor: {
              logicalSessionId: "session-1",
              sessionLineage: "2".repeat(32),
              authorityProfile: "general-writer-v1",
              authorityProfileVersion: "1",
              policyDigest: "f".repeat(64),
              storageLineage: "1".repeat(32),
              workerBinding: "worker-2",
              fenceEpoch: 2
            }
          }
        }
      })
    );
    expect(() =>
      fenced.apply(
        canonicalJournalRecordSchema.parse({
          ...records[2],
          cursor: 4,
          transactionId: "late-after-adoption"
        })
      )
    ).toThrow("fenced by a newer worker");

    const live = new CanonicalJournalReducer();
    records.forEach((record) => live.apply(record));
    const replay = new CanonicalJournalReducer();
    records.forEach((record) => replay.apply(record));
    expect(replay.snapshot()).toEqual(live.snapshot());
    expect(replay.snapshot().sessions["session-1"]?.completedEffects[0]).toMatchObject({
      resultRef: "result-1",
      conversation: { backendThreadRef: "thread-1" },
      usage
    });
    expect(replay.snapshot().sessions["session-1"]?.completionDecisions).toHaveLength(1);

    replay.apply(
      canonicalJournalRecordSchema.parse({
        version: SESSION_JOURNAL_VERSION,
        cursor: 8,
        transactionId: "terminal-1",
        sessionId: "session-1",
        event: {
          kind: "turn_terminal",
          payload: { turnId: "turn-1", reason: "fenced", relatedEffectId: "attempt-1" }
        }
      })
    );
    expect(() =>
      replay.apply(
        canonicalJournalRecordSchema.parse({
          version: SESSION_JOURNAL_VERSION,
          cursor: 9,
          transactionId: "late-complete",
          sessionId: "session-1",
          event: {
            kind: "effect_completed",
            payload: { effectId: "attempt-1", resultDigest: "d".repeat(64) }
          }
        })
      )
    ).toThrow("canonical turn is terminal");

    const multiSession = new CanonicalJournalReducer();
    multiSession.apply(records[0]!);
    multiSession.apply(
      canonicalJournalRecordSchema.parse({
        ...records[0],
        cursor: 2,
        transactionId: "open-2",
        sessionId: "session-2",
        event: {
          kind: "session_opened",
          payload: { ...records[0]!.event.payload, sessionLineageId: "3".repeat(32) }
        }
      })
    );
    expect(Object.keys(multiSession.snapshot().sessions).sort()).toEqual([
      "session-1",
      "session-2"
    ]);
    expect(() =>
      multiSession.apply(
        canonicalJournalRecordSchema.parse({
          ...records[0],
          cursor: 3,
          transactionId: "conflicting-reopen"
        })
      )
    ).toThrow("already initialized");

    const retryBudget = new ContinuationBudgetAccount(policy, 1_000);
    const firstReservation = retryBudget.reserveTurn("session-1", "retry-first", 0, 1_100);
    const freshReservation = retryBudget.reserveTurn(
      "session-1",
      "retry-fresh",
      0,
      1_200,
      "missing_backend_thread"
    );
    const firstAuthorization = canonicalJournalRecordSchema.parse({
      ...records[1],
      transactionId: "retry-first",
      event: {
        kind: "effect_authorized",
        payload: {
          ...records[1]!.event.payload,
          effectId: "retry-attempt-1",
          idempotencyKey: "retry-first",
          budgetEvent: firstReservation
        }
      }
    });
    const freshAuthorization = canonicalJournalRecordSchema.parse({
      ...records[1],
      cursor: 3,
      transactionId: "retry-fresh",
      event: {
        kind: "effect_authorized",
        payload: {
          ...records[1]!.event.payload,
          effectId: "retry-attempt-2",
          idempotencyKey: "retry-fresh",
          budgetEvent: freshReservation
        }
      }
    });
    const missingThreadCompletion = canonicalJournalRecordSchema.parse({
      version: SESSION_JOURNAL_VERSION,
      cursor: 3,
      transactionId: "retry-missing-thread",
      sessionId: "session-1",
      event: {
        kind: "effect_completed",
        payload: {
          effectId: "retry-attempt-1",
          resultDigest: "9".repeat(64),
          runtimeOutcome: "missing_backend_thread"
        }
      }
    });
    const unauthorizedRetry = new CanonicalJournalReducer();
    unauthorizedRetry.apply(records[0]!);
    unauthorizedRetry.apply(firstAuthorization);
    expect(() => unauthorizedRetry.apply(freshAuthorization)).toThrow(
      "lacks a completed missing backend thread predecessor"
    );
    const borrowedRetry = structuredClone(freshAuthorization);
    if (borrowedRetry.event.kind !== "effect_authorized")
      throw new Error("missing retry authorization fixture");
    borrowedRetry.event.payload.turnId = "unrelated-turn";
    const crossTurnRetry = new CanonicalJournalReducer();
    crossTurnRetry.apply(records[0]!);
    crossTurnRetry.apply(firstAuthorization);
    crossTurnRetry.apply(missingThreadCompletion);
    expect(() => crossTurnRetry.apply({ ...borrowedRetry, cursor: 4 })).toThrow(
      "lacks a completed missing backend thread predecessor"
    );
    const authorizedRetry = new CanonicalJournalReducer();
    authorizedRetry.apply(records[0]!);
    authorizedRetry.apply(firstAuthorization);
    authorizedRetry.apply(missingThreadCompletion);
    expect(() =>
      authorizedRetry.apply(
        canonicalJournalRecordSchema.parse({
          ...freshAuthorization,
          cursor: 4
        })
      )
    ).not.toThrow();
  });

  test("requires exact atomic usage accounting and preserves janitor targets", () => {
    const base = {
      version: SESSION_JOURNAL_VERSION,
      cursor: 1,
      transactionId: "transaction-1",
      sessionId: "session-1"
    } as const;
    expect(
      canonicalJournalRecordSchema.parse({
        ...base,
        event: {
          kind: "effect_completed",
          payload: {
            effectId: "attempt-1",
            resultDigest: "a".repeat(64),
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
              reasoningOutputTokens: 0,
              totalTokens: 2,
              runtimeMs: 1
            }
          }
        }
      }).event.kind
    ).toBe("effect_completed");

    const reducer = new CanonicalJournalReducer();
    reducer.apply(
      canonicalJournalRecordSchema.parse({
        ...base,
        event: {
          kind: "session_opened",
          payload: {
            coordinatorBinding: "coordinator",
            authorityBinding: "authority",
            workerBinding: "worker-1",
            storageLineageId: "storage-1",
            fenceEpoch: 1,
            sessionLineageId: "lineage-1",
            authorityProfile: "general-writer-v1",
            authorityProfileVersion: "1",
            policyDigest: "f".repeat(64),
            workspace: { workspaceRef: "workspace-1", uid: 1, gid: 1 }
          }
        }
      })
    );
    reducer.apply(
      canonicalJournalRecordSchema.parse({
        ...base,
        cursor: 2,
        transactionId: "plan-1",
        event: {
          kind: "janitor_planned",
          payload: {
            planId: "plan-1",
            repositoryRef: "repository-1",
            exactTargets: ["workspace-1"],
            classification: "clean_disposable"
          }
        }
      })
    );
    expect(() =>
      reducer.apply(
        canonicalJournalRecordSchema.parse({
          ...base,
          cursor: 3,
          transactionId: "apply-1",
          event: {
            kind: "janitor_applied",
            payload: {
              planId: "plan-1",
              repositoryRef: "repository-1",
              exactTargets: ["workspace-1", "unplanned"]
            }
          }
        })
      )
    ).toThrow("widens or changes its plan");
  });
});
