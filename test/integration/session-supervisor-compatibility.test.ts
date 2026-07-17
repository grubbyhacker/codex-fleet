import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  LegacyAgentdV1JournalReader,
  LegacyDeferredVerifierAdapter,
  SESSION_JOURNAL_VERSION,
  canonicalJournalRecordSchema,
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
});
