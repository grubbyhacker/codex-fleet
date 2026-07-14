import { describe, expect, it } from "vitest";

import {
  AGENTD_PROTOCOL_VERSION,
  InMemorySessionJournal,
  MissingBackendThreadError,
  SequenceIds,
  SessionSupervisor,
  type AgentdEvent,
  type CompletionVerifier,
  type RuntimeAdapter,
  type RuntimeInput,
  type RuntimeResult,
  type SessionJournal,
  type SessionStatus,
  type TurnStatus
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

class ReplayJournal implements SessionJournal {
  constructor(private readonly events: AgentdEvent[]) {}
  append(event: Parameters<SessionJournal["append"]>[0]): AgentdEvent {
    const written = { ...event, cursor: this.events.length + 1 } as AgentdEvent;
    this.events.push(written);
    return written;
  }
  read(): AgentdEvent[] {
    return this.events;
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

  it("replays unresolved attempts for reconciliation and remains collision-safe on a second restart", async () => {
    const journal = new InMemorySessionJournal();
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    const session = supervisor.createSession(command("interrupted"));
    const accepted = supervisor.submitTurn(turn(session.sessionId, "broken"));
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
    expect(journal.read().find((event) => event.kind === "attempt_started")?.payload).toMatchObject(
      {
        turn: { turnId: accepted.turnId, phase: "running" }
      }
    );
    expect(replayed.getTurn(accepted.turnId)).toMatchObject({
      phase: "reconciliation",
      recoveryFacts: ["interrupted_attempt_requires_reconciliation"]
    });
    const restarted = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    expect(restarted.getTurn(accepted.turnId).phase).toBe("reconciliation");
    const newSession = restarted.createSession(command("new"));
    const newTurn = restarted.submitTurn(turn(newSession.sessionId, "new"));
    expect(newSession.sessionId).not.toBe(session.sessionId);
    expect(newTurn.turnId).not.toBe(accepted.turnId);
  });

  it("preserves a generated continuity-degraded safe fallback across replay", async () => {
    let calls = 0;
    const journal = new InMemorySessionJournal();
    const source = new SessionSupervisor(
      journal,
      {
        async runTurn() {
          calls += 1;
          if (calls === 1)
            return {
              conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "old" }
            };
          if (calls === 2) throw new MissingBackendThreadError();
          return new Promise<RuntimeResult>(() => undefined);
        }
      },
      satisfied,
      new SequenceIds()
    );
    const session = source.createSession(command("continuity"));
    source.submitTurn(turn(session.sessionId, "seed"));
    await settle();
    const fallback = source.submitTurn(turn(session.sessionId, "fallback"));
    await settle();
    await settle();
    const degraded = journal.read().find((event) => event.kind === "continuity_degraded");
    if (!degraded) throw new Error("missing continuity_degraded event");
    const replayJournal = new ReplayJournal(
      journal.read().filter((event) => event.cursor <= degraded.cursor)
    );
    const adapter = new ControlledAdapter();
    const replayed = new SessionSupervisor(replayJournal, adapter, satisfied, new SequenceIds());
    expect(replayed.getTurn(fallback.turnId)).toMatchObject({
      phase: "queued",
      recoveryFacts: ["backend_thread_missing_fresh_adapter_attempt"]
    });
    const secondRestart = new SessionSupervisor(
      replayJournal,
      adapter,
      satisfied,
      new SequenceIds()
    );
    expect(secondRestart.getTurn(fallback.turnId).phase).toBe("queued");
    replayed.resumeSession({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId });
    await settle();
    expect(adapter.inputs).toHaveLength(1);
    adapter.complete(0, "replacement");
    await settle();
    expect(replayed.getTurn(fallback.turnId).phase).toBe("completed");
  });

  it("resumes only queued work and leaves cancelled and terminated work inert", async () => {
    const activeSession: SessionStatus = {
      version: AGENTD_PROTOCOL_VERSION,
      sessionId: "active-session",
      coordinatorBinding: "coordinator",
      authorityBinding: "authority",
      workspace: { workspaceRef: "active" },
      phase: "active",
      turnIds: ["queued-turn", "cancelled-turn"],
      nextCursor: 1
    };
    const terminatedSession: SessionStatus = {
      ...activeSession,
      sessionId: "terminated-session",
      workspace: { workspaceRef: "terminated" },
      phase: "terminated",
      turnIds: ["terminated-turn"]
    };
    const storedTurn = (
      turnId: string,
      sessionId: string,
      phase: TurnStatus["phase"]
    ): TurnStatus => ({
      turnId,
      sessionId,
      prompt: turnId,
      idempotencyKey: turnId,
      phase,
      attemptIds: [],
      recoveryFacts: [],
      continuationDepth: 0
    });
    const queued = storedTurn("queued-turn", activeSession.sessionId, "queued");
    const cancelled = storedTurn("cancelled-turn", activeSession.sessionId, "cancelled");
    const terminated = storedTurn("terminated-turn", terminatedSession.sessionId, "queued");
    const events: AgentdEvent[] = [
      {
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 1,
        kind: "session_created",
        sessionId: activeSession.sessionId,
        payload: { session: activeSession }
      } as AgentdEvent,
      {
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 2,
        kind: "turn_enqueued",
        sessionId: activeSession.sessionId,
        turnId: queued.turnId,
        payload: { turn: queued }
      } as AgentdEvent,
      {
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 3,
        kind: "turn_enqueued",
        sessionId: activeSession.sessionId,
        turnId: cancelled.turnId,
        payload: { turn: cancelled }
      } as AgentdEvent,
      {
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 4,
        kind: "turn_cancelled",
        sessionId: activeSession.sessionId,
        turnId: cancelled.turnId,
        payload: { turn: cancelled }
      } as AgentdEvent,
      {
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 5,
        kind: "session_created",
        sessionId: terminatedSession.sessionId,
        payload: { session: terminatedSession }
      } as AgentdEvent,
      {
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 6,
        kind: "turn_enqueued",
        sessionId: terminatedSession.sessionId,
        turnId: terminated.turnId,
        payload: { turn: terminated }
      } as AgentdEvent,
      {
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 7,
        kind: "session_terminated",
        sessionId: terminatedSession.sessionId,
        payload: {}
      } as AgentdEvent
    ];
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(
      new ReplayJournal(events),
      adapter,
      satisfied,
      new SequenceIds()
    );
    supervisor.resumeSession({
      version: AGENTD_PROTOCOL_VERSION,
      sessionId: activeSession.sessionId
    });
    await settle();
    expect(adapter.inputs.map((input) => input.turn.turnId)).toEqual([queued.turnId]);
    expect(() =>
      supervisor.resumeSession({
        version: AGENTD_PROTOCOL_VERSION,
        sessionId: terminatedSession.sessionId
      })
    ).toThrow("terminated session cannot resume");
    expect(supervisor.getTurn(cancelled.turnId).phase).toBe("cancelled");
    expect(supervisor.getTurn(terminated.turnId).phase).toBe("queued");
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

  it("rejects invalid finite session concurrency limits", () => {
    const journal = new InMemorySessionJournal();
    for (const limit of [0, -1, 1.5, Number.NaN])
      expect(
        () =>
          new SessionSupervisor(
            journal,
            new ControlledAdapter(),
            satisfied,
            new SequenceIds(),
            1,
            limit
          )
      ).toThrow("maxConcurrentSessions must be a positive integer or Infinity");
  });
});
