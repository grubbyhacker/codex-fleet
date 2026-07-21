import { describe, expect, test } from "bun:test";

import {
  CanonicalJournalReducer,
  ContinuationBudgetAccount,
  SESSION_JOURNAL_VERSION,
  canonicalJournalRecordSchema,
  canonicalValueDigest,
  type RegisteredTaskSnapshot,
  type RegisteredVerifierResult
} from "@grubbyhacker/session-supervisor";

const policy = {
  maxContinuations: 1,
  maxModelTurns: 2,
  wallClockDeadlineMs: 10_000,
  maxTotalTokens: 1_000,
  maxRuntimeMs: 5_000,
  perTurnTimeoutMs: 1_000
} as const;
const task = {
  taskKind: "github_green_pr_v1",
  completionContract: "github_green_pr_v1",
  verifierId: "github_green_pr_v1",
  contractDigest: `sha256:${"a".repeat(64)}`,
  parameters: { repository: "fixture" },
  taskEvidenceDigest: `sha256:${"b".repeat(64)}`,
  budget: policy
} as const;
const waitingResult = {
  outcome: "waiting" as const,
  contractDigest: task.contractDigest,
  taskEvidenceDigest: task.taskEvidenceDigest,
  headRevision: "head-1",
  reasons: [{ code: "required_check_pending", evidenceRef: "observation-1" }],
  evidenceRefs: ["observation-1"]
};

function open(reducer: CanonicalJournalReducer): number {
  reducer.apply({
    version: SESSION_JOURNAL_VERSION,
    cursor: 1,
    transactionId: "open",
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
        authorityProfile: "profile",
        authorityProfileVersion: "v1",
        policyDigest: "3".repeat(64),
        workspace: { workspaceRef: "workspace", uid: 1, gid: 1 }
      }
    }
  });
  return 2;
}

function modelTurn(reducer: CanonicalJournalReducer, cursor: number): number {
  const account = new ContinuationBudgetAccount(policy, 1_000);
  const reservation = account.reserveTurn("session-1", "model-1", 0, 1_001);
  reducer.apply({
    version: SESSION_JOURNAL_VERSION,
    cursor,
    transactionId: "model-auth",
    sessionId: "session-1",
    event: {
      kind: "effect_authorized",
      payload: {
        effectId: "model-effect",
        effectKind: "model_turn",
        idempotencyKey: "model-1",
        targetRef: "model",
        turnId: "turn-1",
        fenceEpoch: 1,
        task,
        budgetEvent: reservation
      }
    }
  });
  const usage = {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
    runtimeMs: 1
  };
  reducer.apply({
    version: SESSION_JOURNAL_VERSION,
    cursor: cursor + 1,
    transactionId: "model-complete",
    sessionId: "session-1",
    event: {
      kind: "effect_completed",
      payload: {
        effectId: "model-effect",
        resultDigest: "4".repeat(64),
        usage,
        budgetEvent: account.recordUsage("session-1", "model-effect", usage)
      }
    }
  });
  return cursor + 2;
}

function observation(
  reducer: CanonicalJournalReducer,
  cursor: number,
  effectId: string,
  result: RegisteredVerifierResult = waitingResult
): number {
  reducer.apply({
    version: SESSION_JOURNAL_VERSION,
    cursor,
    transactionId: `${effectId}-auth`,
    sessionId: "session-1",
    event: {
      kind: "effect_authorized",
      payload: {
        effectId,
        effectKind: "verifier",
        idempotencyKey: effectId,
        targetRef: "typed-broker-observation",
        turnId: "turn-1",
        fenceEpoch: 1,
        task
      }
    }
  });
  reducer.apply({
    version: SESSION_JOURNAL_VERSION,
    cursor: cursor + 1,
    transactionId: `${effectId}-complete`,
    sessionId: "session-1",
    event: {
      kind: "effect_completed",
      payload: { effectId, resultDigest: canonicalValueDigest(result) }
    }
  });
  return cursor + 2;
}

function waiting(
  reducer: CanonicalJournalReducer,
  cursor: number,
  effectId = "verifier-1"
): number {
  reducer.apply({
    version: SESSION_JOURNAL_VERSION,
    cursor,
    transactionId: `${effectId}-waiting`,
    sessionId: "session-1",
    event: {
      kind: "completion_waiting",
      payload: {
        turnId: "turn-1",
        task,
        verifierEffectId: effectId,
        fenceEpoch: 1,
        verifierResult: waitingResult,
        observationDigest: "5".repeat(64),
        pollDeadlineAtMs: 2_000
      }
    }
  });
  return cursor + 1;
}

function completionBudgetDecision() {
  const account = new ContinuationBudgetAccount(policy, 1_000);
  account.reserveTurn("session-1", "model-1", 0, 1_001);
  account.recordUsage("session-1", "model-effect", {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
    runtimeMs: 1
  });
  return account.decideCompletion("session-1", 1_500);
}

function continuationBudgetReservation() {
  const account = new ContinuationBudgetAccount(policy, 1_000);
  account.reserveTurn("session-1", "model-1", 0, 1_001);
  account.recordUsage("session-1", "model-effect", {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
    runtimeMs: 1
  });
  account.decideCompletion("session-1", 1_500);
  const reservation = account.reserveTurn("session-1", "continuation-1", 1, 1_501);
  if (reservation.kind !== "budget_reserved")
    throw new Error("fixture continuation reservation was exhausted");
  return reservation;
}

function authorizeContinuationModel(
  reducer: CanonicalJournalReducer,
  cursor: number,
  reservation = continuationBudgetReservation(),
  registeredTask: RegisteredTaskSnapshot = task
): void {
  reducer.apply({
    version: SESSION_JOURNAL_VERSION,
    cursor,
    transactionId: "continuation-model-auth",
    sessionId: "session-1",
    event: {
      kind: "effect_authorized",
      payload: {
        effectId: "continuation-model-effect",
        effectKind: "model_turn",
        idempotencyKey: reservation.reservation.idempotencyKey,
        targetRef: "model",
        turnId: "turn-2",
        parentTurnId: "turn-1",
        fenceEpoch: 1,
        task: registeredTask,
        budgetEvent: reservation
      }
    }
  });
}

describe("canonical waiting observations", () => {
  test("is nonterminal, replay-idempotent, and permits only ordered token-free observations", () => {
    const reducer = new CanonicalJournalReducer();
    let cursor = open(reducer);
    cursor = modelTurn(reducer, cursor);
    cursor = observation(reducer, cursor, "verifier-1");
    cursor = waiting(reducer, cursor);
    const replay = reducer.snapshot();
    cursor = waiting(reducer, cursor);
    expect(reducer.snapshot().sessions["session-1"]?.waitingObservations).toEqual(
      replay.sessions["session-1"]?.waitingObservations
    );
    cursor = observation(reducer, cursor, "verifier-2");
    cursor = waiting(reducer, cursor, "verifier-2");
    const snapshot = reducer.snapshot().sessions["session-1"]!;
    expect(snapshot.waitingObservations).toHaveLength(2);
    expect(snapshot.continuations).toHaveLength(0);
    expect(
      snapshot.budgetSnapshots[`${task.contractDigest}:${task.taskEvidenceDigest}`]?.reservations
    ).toHaveLength(1);
    expect(cursor).toBe(11);
  });

  test("refuses conflicting replays, stale fences, and a second observation before waiting", () => {
    const reducer = new CanonicalJournalReducer();
    let cursor = open(reducer);
    cursor = modelTurn(reducer, cursor);
    cursor = observation(reducer, cursor, "verifier-1");
    expect(() => observation(reducer, cursor, "verifier-2")).toThrow(
      "later verifier observation requires a preceding waiting record"
    );
    cursor = waiting(reducer, cursor);
    expect(() =>
      reducer.apply({
        version: SESSION_JOURNAL_VERSION,
        cursor,
        transactionId: "conflict",
        sessionId: "session-1",
        event: {
          kind: "completion_waiting",
          payload: {
            turnId: "turn-1",
            task,
            verifierEffectId: "verifier-1",
            fenceEpoch: 1,
            verifierResult: waitingResult,
            observationDigest: "6".repeat(64),
            pollDeadlineAtMs: 2_000
          }
        }
      })
    ).toThrow("conflicting waiting observation replay");
    expect(() =>
      reducer.apply({
        version: SESSION_JOURNAL_VERSION,
        cursor,
        transactionId: "stale-fence",
        sessionId: "session-1",
        event: {
          kind: "completion_waiting",
          payload: {
            turnId: "turn-1",
            task,
            verifierEffectId: "verifier-1",
            fenceEpoch: 2,
            verifierResult: waitingResult,
            observationDigest: "5".repeat(64),
            pollDeadlineAtMs: 2_000
          }
        }
      })
    ).toThrow("waiting observation is fenced by a newer worker");
    expect(() =>
      canonicalJournalRecordSchema.parse({
        version: SESSION_JOURNAL_VERSION,
        cursor,
        transactionId: "wrong-outcome",
        sessionId: "session-1",
        event: {
          kind: "completion_waiting",
          payload: {
            turnId: "turn-1",
            task,
            verifierEffectId: "verifier-1",
            fenceEpoch: 1,
            verifierResult: { ...waitingResult, outcome: "satisfied", reasons: [] },
            observationDigest: "5".repeat(64),
            pollDeadlineAtMs: 2_000
          }
        }
      })
    ).toThrow("nonterminal observation requires the waiting verifier outcome");
  });

  test("blocks a depth-one model reservation while completion is unresolved", () => {
    const reducer = new CanonicalJournalReducer();
    let cursor = open(reducer);
    cursor = modelTurn(reducer, cursor);
    cursor = observation(reducer, cursor, "verifier-1");
    cursor = waiting(reducer, cursor);
    const budgetBefore = reducer.snapshot().sessions["session-1"]?.budgetSnapshots;
    const account = new ContinuationBudgetAccount(policy, 1_000);
    account.reserveTurn("session-1", "model-1", 0, 1_001);
    account.recordUsage("session-1", "model-effect", {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 2,
      runtimeMs: 1
    });
    expect(() =>
      reducer.apply({
        version: SESSION_JOURNAL_VERSION,
        cursor,
        transactionId: "unauthorized-depth-one-model",
        sessionId: "session-1",
        event: {
          kind: "effect_authorized",
          payload: {
            effectId: "model-effect-2",
            effectKind: "model_turn",
            idempotencyKey: "model-2",
            targetRef: "model",
            turnId: "turn-2",
            parentTurnId: "turn-1",
            fenceEpoch: 1,
            task,
            budgetEvent: account.reserveTurn("session-1", "model-2", 1, 1_500)
          }
        }
      })
    ).toThrow("unresolved waiting observation blocks model turn authorization");
    expect(reducer.snapshot().sessions["session-1"]?.budgetSnapshots).toEqual(budgetBefore);
  });

  test("satisfied waiting resolution permanently blocks model reservation", () => {
    const reducer = new CanonicalJournalReducer();
    let cursor = open(reducer);
    cursor = modelTurn(reducer, cursor);
    cursor = observation(reducer, cursor, "verifier-1");
    cursor = waiting(reducer, cursor);
    const satisfied = { ...waitingResult, outcome: "satisfied" as const, reasons: [] };
    cursor = observation(reducer, cursor, "verifier-2", satisfied);
    reducer.apply({
      version: SESSION_JOURNAL_VERSION,
      cursor,
      transactionId: "satisfied",
      sessionId: "session-1",
      event: {
        kind: "completion_decided",
        payload: {
          turnId: "turn-1",
          task,
          verifierResult: satisfied,
          budgetDecision: completionBudgetDecision(),
          decidedAtMs: 1_500
        }
      }
    });
    expect(() => observation(reducer, cursor + 1, "verifier-3")).toThrow(
      "canonical completion is already terminal"
    );
    expect(() => authorizeContinuationModel(reducer, cursor + 1)).toThrow(
      "resolved waiting observation permanently blocks model turn authorization"
    );
  });

  test("escalated waiting resolution permanently blocks model reservation and continuation", () => {
    const reducer = new CanonicalJournalReducer();
    let cursor = open(reducer);
    cursor = modelTurn(reducer, cursor);
    cursor = observation(reducer, cursor, "verifier-1");
    cursor = waiting(reducer, cursor);
    const escalated = {
      ...waitingResult,
      outcome: "escalated" as const,
      reasons: [{ code: "wait_deadline_exhausted", evidenceRef: "observation-2" }]
    };
    cursor = observation(reducer, cursor, "verifier-2", escalated);
    reducer.apply({
      version: SESSION_JOURNAL_VERSION,
      cursor,
      transactionId: "deadline-escalated",
      sessionId: "session-1",
      event: {
        kind: "completion_decided",
        payload: {
          turnId: "turn-1",
          task,
          verifierResult: escalated,
          budgetDecision: completionBudgetDecision(),
          decidedAtMs: 2_000
        }
      }
    });
    expect(reducer.snapshot().sessions["session-1"]?.continuations).toHaveLength(0);
    expect(() => authorizeContinuationModel(reducer, cursor + 1)).toThrow(
      "resolved waiting observation permanently blocks model turn authorization"
    );
    expect(() =>
      reducer.apply({
        version: SESSION_JOURNAL_VERSION,
        cursor: cursor + 1,
        transactionId: "escalated-continuation-linked",
        sessionId: "session-1",
        event: {
          kind: "continuation_linked",
          payload: {
            sourceTurnId: "turn-1",
            continuationTurnId: "turn-2",
            input: {
              taskKind: task.taskKind,
              completionContract: task.completionContract,
              contractDigest: task.contractDigest,
              taskEvidenceDigest: task.taskEvidenceDigest,
              parentTurnId: "turn-1",
              continuationDepth: 1,
              reasonCodes: ["wait_deadline_exhausted"]
            },
            reservation: continuationBudgetReservation()
          }
        }
      })
    ).toThrow("continuation lacks a completed verifier continuation decision");
  });

  test("requires a linked continuation before authorizing its next-depth model turn", () => {
    const reducer = new CanonicalJournalReducer();
    let cursor = open(reducer);
    cursor = modelTurn(reducer, cursor);
    cursor = observation(reducer, cursor, "verifier-1");
    cursor = waiting(reducer, cursor);
    const continued = {
      ...waitingResult,
      outcome: "continuation" as const,
      reasons: [{ code: "required_check_pending", evidenceRef: "observation-2" }]
    };
    cursor = observation(reducer, cursor, "verifier-2", continued);
    reducer.apply({
      version: SESSION_JOURNAL_VERSION,
      cursor,
      transactionId: "continued",
      sessionId: "session-1",
      event: {
        kind: "completion_decided",
        payload: {
          turnId: "turn-1",
          task,
          verifierResult: continued,
          budgetDecision: completionBudgetDecision(),
          decidedAtMs: 1_500
        }
      }
    });
    expect(() => authorizeContinuationModel(reducer, cursor + 1)).toThrow(
      "waiting continuation requires a matching linked model turn authorization"
    );
    reducer.apply({
      version: SESSION_JOURNAL_VERSION,
      cursor: cursor + 1,
      transactionId: "continuation-linked",
      sessionId: "session-1",
      event: {
        kind: "continuation_linked",
        payload: {
          sourceTurnId: "turn-1",
          continuationTurnId: "turn-2",
          input: {
            taskKind: task.taskKind,
            completionContract: task.completionContract,
            contractDigest: task.contractDigest,
            taskEvidenceDigest: task.taskEvidenceDigest,
            parentTurnId: "turn-1",
            continuationDepth: 1,
            reasonCodes: ["required_check_pending"]
          },
          reservation: continuationBudgetReservation()
        }
      }
    });
    expect(() =>
      authorizeContinuationModel(reducer, cursor + 2, continuationBudgetReservation(), {
        ...task,
        parameters: { repository: "mutated-fixture" }
      })
    ).toThrow("waiting continuation requires a matching linked model turn authorization");
    authorizeContinuationModel(reducer, cursor + 2);
    expect(
      reducer
        .snapshot()
        .sessions[
          "session-1"
        ]?.authorizedEffects.find((effect) => effect.effectId === "continuation-model-effect")
    ).toBeDefined();
    expect(() => observation(reducer, cursor + 3, "verifier-3")).toThrow(
      "canonical completion is already terminal"
    );
  });
});
