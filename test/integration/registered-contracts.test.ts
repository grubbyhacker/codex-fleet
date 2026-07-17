import { describe, expect, it } from "vitest";

import {
  ContinuationBudgetAccount,
  SessionReassignmentReducer,
  type ContinuationBudgetPolicy,
  type ReassignmentFingerprint,
  type SessionAdoptionBinding
} from "@grubbyhacker/session-supervisor";

const policy: ContinuationBudgetPolicy = {
  maxContinuations: 1,
  maxModelTurns: 2,
  wallClockDeadlineMs: 60_000,
  maxTotalTokens: 100,
  maxRuntimeMs: 10_000,
  perTurnTimeoutMs: 8_000
};
const sessionLineage = "a".repeat(32);
const policyDigest = "b".repeat(64);
const storageLineage = "c".repeat(32);

describe("registered continuation budget accounting", () => {
  it("reserves before admission, replays idempotently, and exhausts every cumulative bound", () => {
    const account = new ContinuationBudgetAccount(policy, 1_000);
    const initial = account.reserveTurn("session-1", "initial", 0, 1_100);
    expect(initial).toMatchObject({
      kind: "budget_reserved",
      reservation: { turnOrdinal: 1, continuationDepth: 0, timeoutMs: 8_000 }
    });
    expect(account.reserveTurn("session-1", "initial", 0, 2_000)).toEqual(initial);
    account.recordUsage("session-1", "attempt-1", {
      inputTokens: 30,
      outputTokens: 20,
      totalTokens: 50,
      runtimeMs: 4_000
    });
    const continuation = account.reserveTurn("session-1", "continuation-1", 1, 2_000);
    expect(continuation).toMatchObject({
      kind: "budget_reserved",
      reservation: { turnOrdinal: 2, continuationDepth: 1, timeoutMs: 6_000 }
    });
    expect(account.reserveTurn("session-1", "continuation-2", 2, 2_100)).toMatchObject({
      kind: "budget_exhausted",
      reason: "continuation_limit"
    });
    const modelLimited = new ContinuationBudgetAccount({ ...policy, maxContinuations: 3 }, 1_000);
    modelLimited.reserveTurn("session-1", "model-1", 0, 1_100);
    modelLimited.reserveTurn("session-1", "model-2", 1, 1_200);
    expect(modelLimited.reserveTurn("session-1", "model-3", 2, 1_300)).toMatchObject({
      kind: "budget_exhausted",
      reason: "model_turn_limit"
    });
  });

  it("accounts usage exactly once and rejects conflicting replay", () => {
    const account = new ContinuationBudgetAccount(policy, 1_000);
    account.reserveTurn("session-1", "initial", 0, 1_100);
    const usage = { inputTokens: 60, outputTokens: 40, totalTokens: 100, runtimeMs: 5_000 };
    const first = account.recordUsage("session-1", "attempt-1", usage);
    expect(account.recordUsage("session-1", "attempt-1", usage)).toEqual(first);
    expect(() =>
      account.recordUsage("session-1", "attempt-1", {
        inputTokens: 61,
        outputTokens: 40,
        totalTokens: 101,
        runtimeMs: 5_000
      })
    ).toThrow("conflicting usage replay");
    expect(account.reserveTurn("session-1", "next", 1, 2_000)).toMatchObject({
      kind: "budget_exhausted",
      reason: "token_limit"
    });
    expect(account.decideCompletion("session-1", 2_000)).toMatchObject({
      kind: "budget_completion_decided",
      outcome: "within_budget"
    });
  });

  it("requires escalation when recorded usage overruns a cumulative bound", () => {
    const account = new ContinuationBudgetAccount(policy, 1_000);
    account.reserveTurn("session-1", "initial", 0, 1_100);
    account.recordUsage("session-1", "attempt-1", {
      inputTokens: 90,
      outputTokens: 20,
      totalTokens: 110,
      runtimeMs: 11_000
    });
    expect(account.decideCompletion("session-1", 2_000)).toMatchObject({
      kind: "budget_completion_decided",
      outcome: "escalated",
      reason: "token_limit"
    });
  });

  it("rejects restored state that expands or changes the compiled budget", () => {
    const source = new ContinuationBudgetAccount(policy, 1_000);
    source.reserveTurn("session-1", "initial", 0, 1_100);
    const restored = source.snapshot();

    expect(
      () =>
        new ContinuationBudgetAccount(policy, 1_000, {
          ...restored,
          policy: { ...restored.policy, maxTotalTokens: restored.policy.maxTotalTokens + 1 }
        })
    ).toThrow("restored budget policy does not match compiled policy");
    expect(
      () =>
        new ContinuationBudgetAccount(policy, 1_000, {
          ...restored,
          deadlineAtMs: restored.deadlineAtMs + 1
        })
    ).toThrow("restored budget deadline does not match compiled policy");
  });

  it("rejects restored aggregate resets and malformed replay identities", () => {
    const exactPolicy = { ...policy, maxTotalTokens: 10 };
    const source = new ContinuationBudgetAccount(exactPolicy, 1_000);
    source.reserveTurn("session-1", "initial", 0, 1_100);
    source.recordUsage("session-1", "attempt-1", {
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
      runtimeMs: 1_000
    });
    const restored = source.snapshot();

    expect(
      () =>
        new ContinuationBudgetAccount(exactPolicy, 1_000, {
          ...restored,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          runtimeMs: 0
        })
    ).toThrow("restored budget aggregates do not match usage records");
    expect(
      () =>
        new ContinuationBudgetAccount(exactPolicy, 1_000, {
          ...restored,
          reservations: [
            ...restored.reservations,
            {
              ...restored.reservations[0]!,
              idempotencyKey: "continuation-1",
              turnOrdinal: 2,
              continuationDepth: 1,
              reservedAtMs: 1_200
            }
          ],
          usageRecords: [...restored.usageRecords, restored.usageRecords[0]!],
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          runtimeMs: 2_000
        })
    ).toThrow("restored budget has duplicate usage attempt id");
    expect(
      () =>
        new ContinuationBudgetAccount(exactPolicy, 1_000, {
          ...restored,
          reservations: [
            ...restored.reservations,
            { ...restored.reservations[0]!, turnOrdinal: 3, continuationDepth: 1 }
          ]
        })
    ).toThrow("restored budget has duplicate reservation id");
    expect(
      () =>
        new ContinuationBudgetAccount(exactPolicy, 1_000, {
          ...restored,
          reservations: [
            {
              ...restored.reservations[0]!,
              timeoutMs: exactPolicy.perTurnTimeoutMs + 1
            }
          ]
        })
    ).toThrow("restored budget has invalid reservation timeout");
    expect(
      () =>
        new ContinuationBudgetAccount(exactPolicy, 1_000, {
          ...restored,
          reservations: [{ ...restored.reservations[0]!, turnOrdinal: 2 }]
        })
    ).toThrow("restored budget has non-contiguous turn ordinals");
    expect(
      () =>
        new ContinuationBudgetAccount(exactPolicy, 1_000, {
          ...restored,
          reservations: [{ ...restored.reservations[0]!, continuationDepth: 1 }]
        })
    ).toThrow("restored budget has non-contiguous continuation depth");
  });
});

describe("atomic session adoption primitive", () => {
  const predecessor: SessionAdoptionBinding = {
    logicalSessionId: "logical-1",
    sessionLineage,
    authorityProfile: "reviewed-profile",
    authorityProfileVersion: "v1",
    policyDigest,
    storageLineage,
    workerBinding: "worker-a",
    fenceEpoch: 4
  };
  const fingerprint: ReassignmentFingerprint = {
    logicalSessionId: predecessor.logicalSessionId,
    sessionLineage: predecessor.sessionLineage,
    authorityProfile: predecessor.authorityProfile,
    authorityProfileVersion: predecessor.authorityProfileVersion,
    policyDigest: predecessor.policyDigest,
    storageLineage: predecessor.storageLineage,
    predecessorWorker: predecessor.workerBinding,
    predecessorEpoch: predecessor.fenceEpoch,
    successorWorker: "worker-b",
    successorEpoch: 5,
    idempotencyKey: "replace-generation-4"
  };

  it("atomically adopts one exact successor and replays the generation idempotently", () => {
    const reducer = new SessionReassignmentReducer(predecessor);
    const adopted = reducer.adopt(fingerprint);
    expect(adopted).toMatchObject({
      kind: "session_reassigned",
      predecessor,
      successor: { workerBinding: "worker-b", fenceEpoch: 5 }
    });
    expect(reducer.adopt(fingerprint)).toEqual(adopted);
    const replayed = new SessionReassignmentReducer(predecessor, [adopted]);
    expect(replayed.current()).toEqual(adopted.successor);
  });

  it("rejects stale predecessors, skipped epochs, and conflicting generation replay", () => {
    expect(() =>
      new SessionReassignmentReducer(predecessor).adopt({ ...fingerprint, predecessorEpoch: 3 })
    ).toThrow("stale or mismatched reassignment predecessor");
    expect(() =>
      new SessionReassignmentReducer(predecessor).adopt({ ...fingerprint, successorEpoch: 6 })
    ).toThrow("advance exactly one fence epoch");
    const reducer = new SessionReassignmentReducer(predecessor);
    reducer.adopt(fingerprint);
    expect(() => reducer.adopt({ ...fingerprint, successorWorker: "worker-c" })).toThrow(
      "conflicting reassignment replay"
    );
  });

  it("accepts the broker identity wire without transforms and rejects prefixed digests", () => {
    expect(new SessionReassignmentReducer(predecessor).current()).toMatchObject({
      sessionLineage,
      storageLineage,
      policyDigest
    });
    expect(
      () =>
        new SessionReassignmentReducer({
          ...predecessor,
          sessionLineage: `sha256:${"a".repeat(64)}`
        })
    ).toThrow();
    expect(
      () =>
        new SessionReassignmentReducer({
          ...predecessor,
          policyDigest: `sha256:${policyDigest}`
        })
    ).toThrow();
  });
});
