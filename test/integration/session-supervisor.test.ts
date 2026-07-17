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
} from "../fixtures/legacy-session-v1.js";

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

class CancellableControlledAdapter extends ControlledAdapter {
  cancellations = 0;
  async cancelTurn(): Promise<void> {
    this.cancellations += 1;
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

class FaultJournal implements SessionJournal {
  private readonly inner = new InMemorySessionJournal();
  private failedKind?: AgentdEvent["kind"];
  failOn(kind: AgentdEvent["kind"]): void {
    this.failedKind = kind;
  }
  recover(): void {
    this.failedKind = undefined;
  }
  append(event: Parameters<SessionJournal["append"]>[0]): AgentdEvent {
    if (event.kind === this.failedKind) throw new Error(`disk full: ${event.kind}`);
    return this.inner.append(event);
  }
  read(): AgentdEvent[] {
    return this.inner.read();
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
      new SequenceIds(),
      1,
      2
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

  it("uses a finite one-session scheduler capacity by default", async () => {
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(
      new InMemorySessionJournal(),
      adapter,
      satisfied,
      new SequenceIds()
    );
    const first = supervisor.createSession(command("default-one"));
    const second = supervisor.createSession(command("default-two"));
    supervisor.submitTurn(turn(first.sessionId, "one"));
    supervisor.submitTurn(turn(second.sessionId, "two"));
    await settle();
    expect(adapter.inputs).toHaveLength(1);
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

  it("durably reconciles verifier infrastructure failures without sticking or rejecting", async () => {
    const journal = new InMemorySessionJournal();
    let checks = 0;
    const supervisor = new SessionSupervisor(
      journal,
      {
        async runTurn() {
          return {
            conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "thread" }
          };
        }
      },
      {
        async verify() {
          checks += 1;
          if (checks === 1) throw new Error("sensitive verifier infrastructure detail");
          return { outcome: "satisfied", facts: ["checked"] };
        }
      },
      new SequenceIds()
    );
    const session = supervisor.createSession(command("verifier-failure"));
    const failed = supervisor.submitTurn(turn(session.sessionId, "first"));
    const following = supervisor.submitTurn(turn(session.sessionId, "second"));
    await settle();
    await settle();
    await settle();
    expect(supervisor.getTurn(failed.turnId)).toMatchObject({
      phase: "reconciliation",
      recoveryFacts: ["verifier_infrastructure_failure_requires_reconciliation"]
    });
    expect(supervisor.getTurn(following.turnId).phase).toBe("completed");
    expect(journal.read().filter((event) => event.kind === "verifier_failed")).toHaveLength(1);
    expect(JSON.stringify(journal.read())).not.toContain(
      "sensitive verifier infrastructure detail"
    );
    const replayed = new SessionSupervisor(journal, new ControlledAdapter(), satisfied);
    expect(replayed.getTurn(failed.turnId)).toMatchObject({
      phase: "reconciliation",
      recoveryFacts: ["verifier_infrastructure_failure_requires_reconciliation"]
    });
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
    expect(
      replayed.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId })
        .conversation
    ).toBeUndefined();
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
    expect(adapter.inputs[0]?.conversation).toBeUndefined();
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
    const terminatedCancelled = { ...terminated, phase: "cancelled" as const };
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
        payload: { session: terminatedSession, turns: [terminatedCancelled] }
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
    expect(supervisor.getTurn(terminated.turnId).phase).toBe("cancelled");
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
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
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
      ).toThrow("maxConcurrentSessions must be a positive integer");
  });

  it("replays verifier continuation atomically from its journal prefix", async () => {
    const journal = new InMemorySessionJournal();
    const source = new SessionSupervisor(
      journal,
      {
        async runTurn() {
          return {
            conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "thread" }
          };
        }
      },
      {
        async verify() {
          return { outcome: "continue", facts: ["complete the remaining step"] };
        }
      },
      new SequenceIds()
    );
    const session = source.createSession(command("continuation-prefix"));
    const accepted = source.submitTurn(turn(session.sessionId, "source"));
    await settle();
    await settle();
    const continuationEvent = journal
      .read()
      .find((event) => event.kind === "verifier_continuation");
    if (!continuationEvent || continuationEvent.kind !== "verifier_continuation")
      throw new Error("missing verifier continuation");
    const replayJournal = new ReplayJournal(
      journal.read().filter((event) => event.cursor <= continuationEvent.cursor)
    );
    const adapter = new ControlledAdapter();
    const replayed = new SessionSupervisor(replayJournal, adapter, satisfied, new SequenceIds());
    expect(replayed.getTurn(accepted.turnId)).toMatchObject({
      phase: "completed",
      verifierState: "continue"
    });
    expect(replayed.getTurn(continuationEvent.payload.continuationTurn.turnId)).toMatchObject({
      phase: "queued",
      parentTurnId: accepted.turnId
    });
    replayed.resumeSession({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId });
    await settle();
    expect(adapter.inputs[0]?.turn.turnId).toBe(continuationEvent.payload.continuationTurn.turnId);
  });

  it("reserves nested verifier continuation IDs across a reset-ID restart", async () => {
    const journal = new InMemorySessionJournal();
    const source = new SessionSupervisor(
      journal,
      {
        async runTurn() {
          return {
            conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "thread" }
          };
        }
      },
      {
        async verify() {
          return { outcome: "continue", facts: ["continue"] };
        }
      },
      new SequenceIds()
    );
    const session = source.createSession(command("id-prefix"));
    source.submitTurn(turn(session.sessionId, "source"));
    await settle();
    await settle();
    const continuationEvent = journal
      .read()
      .find((event) => event.kind === "verifier_continuation");
    if (!continuationEvent || continuationEvent.kind !== "verifier_continuation")
      throw new Error("missing verifier continuation");
    const replayJournal = new ReplayJournal(
      journal.read().filter((event) => event.cursor <= continuationEvent.cursor)
    );
    const restarted = new SessionSupervisor(
      replayJournal,
      new ControlledAdapter(),
      satisfied,
      new SequenceIds()
    );
    const nextSession = restarted.createSession(command("id-reset"));
    const nextTurn = restarted.submitTurn(turn(nextSession.sessionId, "new"));
    expect(nextTurn.turnId).not.toBe(continuationEvent.payload.continuationTurn.turnId);
  });

  it("applies command state only after its journal append succeeds", async () => {
    const journal = new FaultJournal();
    const adapter = new CancellableControlledAdapter();
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());

    journal.failOn("session_created");
    expect(() => supervisor.createSession(command("rejected-session"))).toThrow("disk full");
    expect(journal.read()).toHaveLength(0);

    journal.recover();
    const session = supervisor.createSession(command("accepted-session"));
    journal.failOn("turn_enqueued");
    expect(() => supervisor.submitTurn(turn(session.sessionId, "same-key"))).toThrow("disk full");
    expect(
      supervisor.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId })
        .turnIds
    ).toEqual([]);

    journal.recover();
    const accepted = supervisor.submitTurn(turn(session.sessionId, "same-key"));
    await settle();
    expect(adapter.inputs.map((input) => input.turn.turnId)).toEqual([accepted.turnId]);

    journal.failOn("session_checkpointed");
    expect(() =>
      supervisor.checkpointSession({
        version: AGENTD_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        checkpointRef: "rejected-checkpoint"
      })
    ).toThrow("disk full");
    expect(
      supervisor.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId })
        .workspace.checkpointRef
    ).toBeUndefined();

    journal.failOn("turn_cancelled");
    await expect(
      supervisor.cancelTurn({
        version: AGENTD_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        turnId: accepted.turnId
      })
    ).rejects.toThrow("disk full");
    expect(supervisor.getTurn(accepted.turnId).phase).toBe("running");
    expect(adapter.cancellations).toBe(0);

    journal.recover();
    await supervisor.cancelTurn({
      version: AGENTD_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      turnId: accepted.turnId
    });
    expect(supervisor.getTurn(accepted.turnId).phase).toBe("cancelled");
    expect(adapter.cancellations).toBe(1);
  });

  it("makes termination atomic with cancellation and runtime side effects", async () => {
    const journal = new FaultJournal();
    const adapter = new CancellableControlledAdapter();
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    const session = supervisor.createSession(command("terminate-append"));
    const accepted = supervisor.submitTurn(turn(session.sessionId, "one"));
    await settle();

    journal.failOn("session_terminated");
    expect(() =>
      supervisor.terminateSession({
        version: AGENTD_PROTOCOL_VERSION,
        sessionId: session.sessionId
      })
    ).toThrow("disk full");
    expect(
      supervisor.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId }).phase
    ).toBe("active");
    expect(supervisor.getTurn(accepted.turnId).phase).toBe("running");
    expect(adapter.cancellations).toBe(0);

    journal.recover();
    supervisor.terminateSession({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId });
    await settle();
    expect(
      supervisor.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId }).phase
    ).toBe("terminated");
    expect(supervisor.getTurn(accepted.turnId).phase).toBe("cancelled");
    expect(adapter.cancellations).toBe(1);
  });

  it("does not invoke a runtime or hot-loop when attempt startup cannot be journaled", async () => {
    const journal = new FaultJournal();
    const adapter = new ControlledAdapter();
    const supervisor = new SessionSupervisor(journal, adapter, satisfied, new SequenceIds());
    const session = supervisor.createSession(command("attempt-append"));
    journal.failOn("attempt_started");
    const accepted = supervisor.submitTurn(turn(session.sessionId, "one"));
    await settle();
    await settle();
    expect(adapter.inputs).toHaveLength(0);
    expect(supervisor.getTurn(accepted.turnId)).toMatchObject({ phase: "queued", attemptIds: [] });
    expect(journal.read().filter((event) => event.kind === "attempt_started")).toHaveLength(0);

    journal.recover();
    supervisor.resumeSession({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId });
    await settle();
    expect(adapter.inputs).toHaveLength(1);
  });

  it("does not apply an unjournaled runtime result or create a ghost verifier continuation", async () => {
    const resultJournal = new FaultJournal();
    const resultAdapter = new ControlledAdapter();
    let resultChecks = 0;
    const resultSupervisor = new SessionSupervisor(
      resultJournal,
      resultAdapter,
      {
        async verify() {
          resultChecks += 1;
          return { outcome: "satisfied", facts: [] };
        }
      },
      new SequenceIds()
    );
    const resultSession = resultSupervisor.createSession(command("result-append"));
    const resultTurn = resultSupervisor.submitTurn(turn(resultSession.sessionId, "one"));
    await settle();
    resultJournal.failOn("attempt_completed");
    resultAdapter.complete(0, "unjournaled-thread");
    await settle();
    expect(resultChecks).toBe(0);
    expect(resultSupervisor.getTurn(resultTurn.turnId).phase).toBe("running");
    expect(
      resultSupervisor.getStatus({
        version: AGENTD_PROTOCOL_VERSION,
        sessionId: resultSession.sessionId
      }).conversation
    ).toBeUndefined();
    const resultReplay = new SessionSupervisor(
      new ReplayJournal(resultJournal.read()),
      new ControlledAdapter(),
      satisfied
    );
    expect(resultReplay.getTurn(resultTurn.turnId).phase).toBe("reconciliation");

    const continuationJournal = new FaultJournal();
    continuationJournal.failOn("verifier_continuation");
    const continuationSupervisor = new SessionSupervisor(
      continuationJournal,
      {
        async runTurn() {
          return {
            conversation: { adapterKind: "test", adapterVersion: "1", backendThreadRef: "thread" }
          };
        }
      },
      {
        async verify() {
          return { outcome: "continue", facts: ["more work"] };
        }
      },
      new SequenceIds()
    );
    const continuationSession = continuationSupervisor.createSession(command("child-append"));
    const source = continuationSupervisor.submitTurn(turn(continuationSession.sessionId, "one"));
    await settle();
    await settle();
    expect(
      continuationSupervisor.getStatus({
        version: AGENTD_PROTOCOL_VERSION,
        sessionId: continuationSession.sessionId
      }).turnIds
    ).toEqual([source.turnId]);
    expect(continuationSupervisor.getTurn(source.turnId).phase).toBe("running");
    expect(
      continuationJournal.read().filter((event) => event.kind === "verifier_continuation")
    ).toHaveLength(0);
  });

  it("records a cancellation failure without undoing termination or rejecting unhandled", async () => {
    const journal = new InMemorySessionJournal();
    const supervisor = new SessionSupervisor(
      journal,
      {
        async runTurn() {
          return new Promise<RuntimeResult>(() => undefined);
        },
        async cancelTurn() {
          throw new Error("adapter cancellation failed: sensitive detail");
        }
      },
      satisfied,
      new SequenceIds()
    );
    const session = supervisor.createSession(command("cancel-failure"));
    const accepted = supervisor.submitTurn(turn(session.sessionId, "one"));
    await settle();
    supervisor.terminateSession({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId });
    await settle();
    expect(supervisor.getTurn(accepted.turnId)).toMatchObject({
      phase: "cancelled",
      recoveryFacts: ["runtime_cancel_failed"]
    });
    expect(
      supervisor.getStatus({ version: AGENTD_PROTOCOL_VERSION, sessionId: session.sessionId }).phase
    ).toBe("terminated");
    expect(
      journal.read().find((event) => event.kind === "cancellation_failed")?.payload
    ).toMatchObject({
      facts: ["runtime_cancel_failed"]
    });
  });
});
