import { describe, expect, it } from "vitest";

import {
  AGENTD_PROTOCOL_VERSION,
  InMemorySessionJournal,
  MissingBackendThreadError,
  SequenceIds,
  SessionSupervisor,
  type CompletionVerifier,
  type RuntimeAdapter,
  type RuntimeInput,
  type RuntimeResult
} from "@codex-fleet/session-supervisor";

class ControlledAdapter implements RuntimeAdapter {
  readonly inputs: RuntimeInput[] = [];
  private resolvers: Array<(result: RuntimeResult) => void> = [];
  runTurn(input: RuntimeInput): Promise<RuntimeResult> {
    this.inputs.push(input);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  complete(index: number, thread = `thread-${index + 1}`): void {
    const resolve = this.resolvers[index];
    if (!resolve) throw new Error(`no adapter call ${index}`);
    resolve({
      conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: thread }
    });
  }
}

const satisfied: CompletionVerifier = {
  async verify() {
    return { outcome: "satisfied", facts: ["checked"] };
  }
};
const command = (workspaceRef: string) => ({
  version: AGENTD_PROTOCOL_VERSION,
  coordinatorBinding: "coordinator-opaque",
  authorityBinding: "authority-opaque",
  workspace: { workspaceRef, branchRef: "branch-opaque" }
});
const turn = (sessionId: string, key: string, prompt = "do work") => ({
  version: AGENTD_PROTOCOL_VERSION,
  sessionId,
  idempotencyKey: key,
  prompt
});
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("session supervisor spike", () => {
  it("runs multiple isolated logical sessions concurrently while allowing only one active turn per session", async () => {
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(
      new InMemorySessionJournal(),
      adapter,
      satisfied,
      new SequenceIds()
    );
    const left = supervisor.createSession(command("workspace-left"));
    const right = supervisor.createSession(command("workspace-right"));
    const leftFirst = supervisor.submitTurn(turn(left.sessionId, "left-1"));
    const leftSecond = supervisor.submitTurn(turn(left.sessionId, "left-2"));
    supervisor.submitTurn(turn(right.sessionId, "right-1"));
    await settle();
    expect(adapter.inputs).toHaveLength(2);
    expect(adapter.inputs.map((input) => input.session.workspace.workspaceRef).sort()).toEqual([
      "workspace-left",
      "workspace-right"
    ]);
    expect(supervisor.getTurn(leftSecond.turnId).phase).toBe("queued");
    adapter.complete(0);
    adapter.complete(1);
    await settle();
    await settle();
    expect(adapter.inputs).toHaveLength(3);
    expect(adapter.inputs[2]?.turn.turnId).toBe(leftSecond.turnId);
    adapter.complete(2);
    await settle();
    expect(supervisor.getTurn(leftFirst.turnId).phase).toBe("completed");
  });

  it("links immutable same-session turns and persists/replays queue, refs, idempotency, cursors, and recovery facts", async () => {
    const journal = new InMemorySessionJournal();
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    const session = supervisor.createSession(command("workspace-a"));
    supervisor.checkpointSession({
      version: AGENTD_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      checkpointRef: "checkpoint-a"
    });
    const first = supervisor.submitTurn(turn(session.sessionId, "key-a"));
    const second = supervisor.submitTurn(turn(session.sessionId, "key-b", "continue"));
    expect(second.parentTurnId).toBe(first.turnId);
    expect(supervisor.submitTurn(turn(session.sessionId, "key-b", "ignored"))).toMatchObject({
      turnId: second.turnId,
      prompt: "continue"
    });
    await settle();
    adapter.complete(0, "thread-a");
    await settle();
    await settle();
    adapter.complete(1, "thread-b");
    await settle();
    const replayed = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    expect(
      replayed.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId })
    ).toMatchObject({
      workspace: {
        workspaceRef: "workspace-a",
        branchRef: "branch-opaque",
        checkpointRef: "checkpoint-a"
      }
    });
    expect(replayed.getTurn(second.turnId)).toMatchObject({
      parentTurnId: first.turnId,
      idempotencyKey: "key-b",
      phase: "completed"
    });
    expect(
      replayed
        .streamEvents({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId, after: 0 })
        .map((event) => event.cursor)
    ).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("makes one fresh same-workspace fallback after a missing backend thread and records continuity degradation", async () => {
    let calls = 0;
    const adapter: RuntimeAdapter = {
      async runTurn(input) {
        calls += 1;
        if (calls === 1)
          return {
            conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "old" }
          };
        if (calls === 2) throw new MissingBackendThreadError();
        return {
          conversation: {
            adapterKind: "test",
            adapterVersion: "2",
            backendThreadRef: "replacement"
          },
          facts: [input.session.workspace.workspaceRef]
        };
      }
    };
    const journal = new InMemorySessionJournal();
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    const session = supervisor.createSession(command("same-workspace"));
    const first = supervisor.submitTurn(turn(session.sessionId, "one"));
    await settle();
    expect(supervisor.getTurn(first.turnId).phase).toBe("completed");
    const continued = supervisor.submitTurn(turn(session.sessionId, "two", "follow up"));
    await settle();
    await settle();
    expect(calls).toBe(3);
    expect(supervisor.getTurn(continued.turnId)).toMatchObject({
      phase: "completed",
      recoveryFacts: ["backend_thread_missing_fresh_adapter_attempt"]
    });
    expect(
      supervisor.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId })
        .conversation?.backendThreadRef
    ).toBe("replacement");
    expect(journal.read().filter((event) => event.kind === "continuity_degraded")).toHaveLength(1);
    const replayed = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    expect(replayed.getTurn(continued.turnId)).toMatchObject({
      phase: "completed",
      recoveryFacts: ["backend_thread_missing_fresh_adapter_attempt"]
    });
    expect(
      replayed.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId })
        .conversation?.backendThreadRef
    ).toBe("replacement");
  });

  it("never loops when the fresh fallback is also missing", async () => {
    let calls = 0;
    const adapter: RuntimeAdapter = {
      async runTurn() {
        calls += 1;
        if (calls === 1)
          return {
            conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "old" }
          };
        throw new MissingBackendThreadError();
      }
    };
    const supervisor = new SessionSupervisor(
      new InMemorySessionJournal(),
      adapter,
      satisfied,
      new SequenceIds()
    );
    const session = supervisor.createSession(command("workspace"));
    supervisor.submitTurn(turn(session.sessionId, "seed"));
    await settle();
    const continuation = supervisor.submitTurn(turn(session.sessionId, "one"));
    await settle();
    await settle();
    expect(calls).toBe(3);
    expect(supervisor.getTurn(continuation.turnId).recoveryFacts).toContain(
      "fresh_adapter_attempt_also_missing_no_loop"
    );
  });

  it("records interrupted attempts for reconciliation and never blindly reruns them", async () => {
    let calls = 0;
    const journal = new InMemorySessionJournal();
    const adapter: RuntimeAdapter = {
      async runTurn() {
        calls += 1;
        throw new Error("authority disconnected");
      }
    };
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    const session = supervisor.createSession(command("workspace"));
    const accepted = supervisor.submitTurn(turn(session.sessionId, "one"));
    await settle();
    expect(calls).toBe(1);
    expect(supervisor.getTurn(accepted.turnId)).toMatchObject({
      phase: "reconciliation",
      recoveryFacts: ["interrupted_attempt_requires_reconciliation"]
    });
    expect(journal.read().filter((event) => event.kind === "attempt_interrupted")).toHaveLength(1);
  });

  it("audits bounded deterministic verifier continuation with satisfied and escalated outcomes", async () => {
    const adapter: RuntimeAdapter = {
      async runTurn() {
        return {
          conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "thread" }
        };
      }
    };
    let checks = 0;
    const journal = new InMemorySessionJournal();
    const verifier: CompletionVerifier = {
      async verify() {
        checks += 1;
        return checks === 1
          ? { outcome: "continue", facts: ["retry once"] }
          : { outcome: "satisfied", facts: ["clean"] };
      }
    };
    const supervisor = new SessionSupervisor(journal, adapter, verifier, new SequenceIds(), 1);
    const session = supervisor.createSession(command("workspace"));
    const accepted = supervisor.submitTurn(turn(session.sessionId, "one"));
    await settle();
    await settle();
    expect(supervisor.getTurn(accepted.turnId)).toMatchObject({
      phase: "completed",
      verifierState: "continue",
      attemptIds: ["attempt-3"]
    });
    const continuation = journal.read().find((event) => event.kind === "verifier_continuation");
    expect(continuation?.payload.continuationTurn).toMatchObject({
      parentTurnId: accepted.turnId,
      prompt: "Continue the prior turn after verifier feedback: retry once",
      phase: "queued"
    });
    if (continuation?.kind !== "verifier_continuation") throw new Error("missing continuation");
    expect(supervisor.getTurn(continuation.payload.continuationTurn.turnId)).toMatchObject({
      phase: "completed",
      verifierState: "satisfied"
    });
    expect(journal.read().some((event) => event.kind === "verifier_continuation")).toBe(true);
    const escalated = new SessionSupervisor(
      new InMemorySessionJournal(),
      adapter,
      {
        async verify() {
          return { outcome: "continue", facts: ["still blocked"] };
        }
      },
      new SequenceIds(),
      0
    );
    const next = escalated.createSession(command("workspace-2"));
    const rejected = escalated.submitTurn(turn(next.sessionId, "one"));
    await settle();
    expect(escalated.getTurn(rejected.turnId)).toMatchObject({
      phase: "failed",
      verifierState: "escalated"
    });
  });

  it("replays terminal, cancelled, reconciliation, and continuity-degraded state and avoids reset ID collisions", async () => {
    const journal = new InMemorySessionJournal();
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    const terminal = supervisor.createSession(command("terminal"));
    const cancelled = supervisor.createSession(command("cancelled"));
    const interrupted = supervisor.createSession(command("interrupted"));
    const continuity = supervisor.createSession(command("continuity"));
    const queued = supervisor.submitTurn(turn(terminal.sessionId, "queued"));
    supervisor.terminateSession({
      version: AGENTD_PROTOCOL_VERSION,
      sessionId: terminal.sessionId
    });
    const cancelledTurn = supervisor.submitTurn(turn(cancelled.sessionId, "cancel"));
    await settle();
    await supervisor.cancelTurn({
      version: AGENTD_PROTOCOL_VERSION,
      sessionId: cancelled.sessionId,
      turnId: cancelledTurn.turnId
    });
    const interruptedTurn = supervisor.submitTurn(turn(interrupted.sessionId, "broken"));
    const continuityTurn = supervisor.submitTurn(turn(continuity.sessionId, "missing"));
    await settle();
    const replayed = new SessionSupervisor(
      journal,
      {
        async runTurn() {
          throw new Error("must not replay");
        }
      },
      satisfied,
      new SequenceIds()
    );
    expect(
      replayed.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: terminal.sessionId }).phase
    ).toBe("terminated");
    expect(replayed.getTurn(queued.turnId).phase).toBe("cancelled");
    expect(replayed.getTurn(cancelledTurn.turnId).phase).toBe("cancelled");
    expect(replayed.getTurn(interruptedTurn.turnId).phase).toBe("queued");
    expect(replayed.getTurn(continuityTurn.turnId).phase).toBe("queued");
    const newSession = replayed.createSession(command("new"));
    const newTurn = replayed.submitTurn(turn(newSession.sessionId, "new"));
    expect(newSession.sessionId).not.toBe(terminal.sessionId);
    expect(newTurn.turnId).not.toBe(queued.turnId);
  });

  it("makes cancellation and termination win late runtime results and never starts terminated queued work", async () => {
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(
      new InMemorySessionJournal(),
      adapter,
      satisfied,
      new SequenceIds(),
      1,
      1
    );
    const session = supervisor.createSession(command("race"));
    const first = supervisor.submitTurn(turn(session.sessionId, "first"));
    const second = supervisor.submitTurn(turn(session.sessionId, "second"));
    await settle();
    await supervisor.cancelTurn({
      version: AGENTD_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      turnId: first.turnId
    });
    adapter.complete(0, "late-cancelled");
    await settle();
    expect(supervisor.getTurn(first.turnId).phase).toBe("cancelled");
    expect(adapter.inputs).toHaveLength(2);
    supervisor.terminateSession({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId });
    adapter.complete(1, "late-terminated");
    await settle();
    expect(supervisor.getTurn(second.turnId).phase).toBe("cancelled");
    expect(
      supervisor.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId })
        .conversation
    ).toBeUndefined();
  });

  it("bounds cross-session workers fairly while retaining one active turn per session", async () => {
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(
      new InMemorySessionJournal(),
      adapter,
      satisfied,
      new SequenceIds(),
      1,
      2
    );
    const sessions = ["a", "b", "c"].map((name) => supervisor.createSession(command(name)));
    sessions.forEach((session) =>
      supervisor.submitTurn(turn(session.sessionId, session.sessionId))
    );
    await settle();
    expect(adapter.inputs).toHaveLength(2);
    adapter.complete(0);
    adapter.complete(1);
    await settle();
    await settle();
    expect(adapter.inputs).toHaveLength(3);
    expect(adapter.inputs[2]?.session.workspace.workspaceRef).toBe("c");
  });
});
