import { describe, expect, it } from "vitest";

import {
  ContinuationBudgetAccount,
  SessionReassignmentReducer,
  type ContinuationBudgetPolicy,
  type ReassignmentFingerprint,
  type SessionAdoptionBinding
} from "@codex-fleet/session-supervisor";

const policy: ContinuationBudgetPolicy = {
  maxContinuations: 1,
  maxModelTurns: 2,
  wallClockDeadlineMs: 60_000,
  maxTotalTokens: 100,
  maxRuntimeMs: 10_000,
  perTurnTimeoutMs: 8_000
};
const sessionLineage = `sha256:${"a".repeat(64)}`;
const policyDigest = `sha256:${"b".repeat(64)}`;
const storageLineage = `sha256:${"c".repeat(64)}`;

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
    expect(account.reserveTurn("session-1", "third-turn", 1, 2_100)).toMatchObject({
      kind: "budget_exhausted",
      reason: "model_turn_limit"
    });
  });

  it("accounts usage exactly once and rejects conflicting replay", () => {
    const account = new ContinuationBudgetAccount(policy, 1_000);
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
});
