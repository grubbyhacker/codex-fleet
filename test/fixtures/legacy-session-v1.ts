import { z } from "zod";

export const AGENTD_PROTOCOL_VERSION = "agentd/v1" as const;
const opaqueRef = z.string().min(1).max(512);
const id = z.string().min(1).max(128);
const facts = z.array(z.string());

export const conversationRefSchema = z
  .object({ adapterKind: id, adapterVersion: id, backendThreadRef: opaqueRef })
  .strict();
export const workspaceBindingSchema = z
  .object({
    workspaceRef: opaqueRef,
    branchRef: opaqueRef.optional(),
    checkpointRef: opaqueRef.optional()
  })
  .strict();
export const createSessionSchema = z
  .object({
    version: z.literal(AGENTD_PROTOCOL_VERSION),
    coordinatorBinding: opaqueRef,
    authorityBinding: opaqueRef,
    workspace: workspaceBindingSchema
  })
  .strict();
export const submitTurnSchema = z
  .object({
    version: z.literal(AGENTD_PROTOCOL_VERSION),
    sessionId: id,
    prompt: z.string().min(1),
    idempotencyKey: id
  })
  .strict();
export const sessionCommandSchemas = {
  create_session: createSessionSchema,
  submit_turn: submitTurnSchema,
  cancel_turn: z
    .object({ version: z.literal(AGENTD_PROTOCOL_VERSION), sessionId: id, turnId: id })
    .strict(),
  checkpoint_session: z
    .object({
      version: z.literal(AGENTD_PROTOCOL_VERSION),
      sessionId: id,
      checkpointRef: opaqueRef
    })
    .strict(),
  resume_session: z.object({ version: z.literal(AGENTD_PROTOCOL_VERSION), sessionId: id }).strict(),
  terminate_session: z
    .object({ version: z.literal(AGENTD_PROTOCOL_VERSION), sessionId: id })
    .strict(),
  stream_events: z
    .object({
      version: z.literal(AGENTD_PROTOCOL_VERSION),
      sessionId: id,
      after: z.number().int().nonnegative().default(0)
    })
    .strict(),
  get_status: z.object({ version: z.literal(AGENTD_PROTOCOL_VERSION), sessionId: id }).strict()
} as const;

const turnPhaseSchema = z.enum([
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed",
  "reconciliation"
]);
const verifierOutcomeSchema = z.enum(["satisfied", "continue", "escalated"]);
const storedTurnSchema = z
  .object({
    turnId: id,
    sessionId: id,
    parentTurnId: id.optional(),
    prompt: z.string().min(1),
    idempotencyKey: id,
    phase: turnPhaseSchema,
    attemptIds: z.array(id),
    verifierState: verifierOutcomeSchema.optional(),
    recoveryFacts: facts,
    continuationDepth: z.number().int().nonnegative()
  })
  .strict();
const storedSessionSchema = z
  .object({
    version: z.literal(AGENTD_PROTOCOL_VERSION),
    sessionId: id,
    coordinatorBinding: opaqueRef,
    authorityBinding: opaqueRef,
    workspace: workspaceBindingSchema,
    phase: z.enum(["active", "terminated"]),
    conversation: conversationRefSchema.optional(),
    activeTurnId: id.optional(),
    turnIds: z.array(id),
    nextCursor: z.number().int().positive()
  })
  .strict();

// This is the complete durable contract. A journal never carries an untyped side payload.
const eventPayloads = {
  session_created: z.object({ session: storedSessionSchema }).strict(),
  turn_enqueued: z.object({ turn: storedTurnSchema }).strict(),
  attempt_started: z
    .object({ turn: storedTurnSchema, conversation: conversationRefSchema.optional() })
    .strict(),
  attempt_completed: z
    .object({ conversation: conversationRefSchema, facts: facts.optional() })
    .strict(),
  attempt_interrupted: z.object({ turn: storedTurnSchema, facts }).strict(),
  turn_cancelled: z.object({ turn: storedTurnSchema }).strict(),
  turn_finished: z.object({ turn: storedTurnSchema }).strict(),
  session_checkpointed: z.object({ checkpointRef: opaqueRef }).strict(),
  session_resumed: z.object({}).strict(),
  session_terminated: z
    .object({ session: storedSessionSchema, turns: z.array(storedTurnSchema) })
    .strict(),
  continuity_degraded: z
    .object({
      turn: storedTurnSchema,
      facts,
      sessionConversation: conversationRefSchema.nullable()
    })
    .strict(),
  verifier_evaluated: z
    .object({ turn: storedTurnSchema, outcome: verifierOutcomeSchema, facts })
    .strict(),
  // This is the atomic terminal transition for a continued source turn. Both snapshots are
  // required so a crash cannot leave a completed source without its deterministic child.
  verifier_continuation: z
    .object({ sourceTurn: storedTurnSchema, continuationTurn: storedTurnSchema, facts })
    .strict(),
  cancellation_failed: z.object({ turn: storedTurnSchema, facts }).strict(),
  verifier_failed: z.object({ turn: storedTurnSchema, facts }).strict(),
  verifier_escalated: z.object({ turn: storedTurnSchema, facts }).strict()
} as const;
const eventBase = {
  version: z.literal(AGENTD_PROTOCOL_VERSION),
  cursor: z.number().int().positive(),
  sessionId: id,
  turnId: id.optional(),
  attemptId: id.optional()
};
export type AgentdEvent = {
  [K in keyof typeof eventPayloads]: {
    version: typeof AGENTD_PROTOCOL_VERSION;
    cursor: number;
    kind: K;
    sessionId: string;
    turnId?: string;
    attemptId?: string;
    payload: z.infer<(typeof eventPayloads)[K]>;
  };
}[keyof typeof eventPayloads];
type JournalEvent = Omit<AgentdEvent, "cursor">;
const eventOptions = Object.entries(eventPayloads).map(([kind, payload]) =>
  z.object({ ...eventBase, kind: z.literal(kind), payload }).strict()
);
const journalEventOptions = Object.entries(eventPayloads).map(([kind, payload]) =>
  z
    .object({
      version: z.literal(AGENTD_PROTOCOL_VERSION),
      sessionId: id,
      turnId: id.optional(),
      attemptId: id.optional(),
      kind: z.literal(kind),
      payload
    })
    .strict()
);
export const agentdEventSchema = z.union(
  eventOptions as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]
) as unknown as z.ZodType<AgentdEvent>;
export const journalEventSchema = z.union(
  journalEventOptions as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]
) as unknown as z.ZodType<JournalEvent>;
export const sessionStatusSchema = storedSessionSchema;

export type ConversationRef = z.infer<typeof conversationRefSchema>;
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;
export type SessionPhase = "active" | "terminated";
export type TurnPhase = z.infer<typeof turnPhaseSchema>;
export type VerifierOutcome = z.infer<typeof verifierOutcomeSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type TurnStatus = z.infer<typeof storedTurnSchema>;

export interface SessionJournal {
  /** Atomic contract: return only after durability; throwing means the event was not appended. */
  append(event: JournalEvent): AgentdEvent;
  read(): AgentdEvent[];
}
/** Test-only journal: production storage must preserve append ordering before invoking a runtime. */
export class InMemorySessionJournal implements SessionJournal {
  private events: AgentdEvent[] = [];
  append(event: JournalEvent): AgentdEvent {
    const written = agentdEventSchema.parse({ ...event, cursor: this.events.length + 1 });
    this.events.push(written);
    return written;
  }
  read(): AgentdEvent[] {
    return this.events.map((event) => agentdEventSchema.parse(event));
  }
}

export type RuntimeInput = {
  session: SessionStatus;
  turn: TurnStatus;
  attemptId: string;
  conversation?: ConversationRef;
};
export type RuntimeResult = { conversation: ConversationRef; facts?: string[] };
export interface RuntimeAdapter {
  runTurn(input: RuntimeInput): Promise<RuntimeResult>;
  cancelTurn?(sessionId: string, turnId: string): Promise<void>;
}
export interface CompletionVerifier {
  verify(
    input: RuntimeInput & { result: RuntimeResult }
  ): Promise<{ outcome: VerifierOutcome; facts: string[] }>;
}
export class MissingBackendThreadError extends Error {
  constructor(message = "backend conversation is missing") {
    super(message);
    this.name = "MissingBackendThreadError";
  }
}
export interface Ids {
  next(prefix: string): string;
}
export class SequenceIds implements Ids {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

/** Backend-neutral logical-session supervisor. Runtime/auth/transport authority stays outside this package. */
export class SessionSupervisor {
  private sessions = new Map<string, SessionStatus>();
  private turns = new Map<string, TurnStatus>();
  private readonly idempotency = new Map<string, string>();
  private readonly usedIds = new Set<string>();
  private readonly running = new Set<string>();
  private readonly ready: string[] = [];
  private readonly journalBlocked = new Set<string>();
  private draining = false;
  private readonly maxConcurrentSessions: number;
  constructor(
    private readonly journal: SessionJournal,
    private readonly runtime: RuntimeAdapter,
    private readonly verifier: CompletionVerifier,
    private readonly ids: Ids = new SequenceIds(),
    private readonly maxVerifierContinuations = 1,
    maxConcurrentSessions = 1
  ) {
    if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions <= 0)
      throw new RangeError("maxConcurrentSessions must be a positive integer");
    this.maxConcurrentSessions = maxConcurrentSessions;
    this.replay();
  }
  createSession(command: z.input<typeof createSessionSchema>): SessionStatus {
    const input = createSessionSchema.parse(command);
    const sessionId = this.uniqueId("session");
    const session: SessionStatus = {
      version: AGENTD_PROTOCOL_VERSION,
      sessionId,
      coordinatorBinding: input.coordinatorBinding,
      authorityBinding: input.authorityBinding,
      workspace: input.workspace,
      phase: "active",
      turnIds: [],
      nextCursor: 1
    };
    this.commit("session_created", sessionId, undefined, undefined, { session });
    return this.status(sessionId);
  }
  submitTurn(command: z.input<typeof submitTurnSchema>): TurnStatus {
    const input = submitTurnSchema.parse(command);
    const session = this.requireActive(input.sessionId);
    const key = `${input.sessionId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return this.copyTurn(this.turn(existing));
    const created = this.buildTurn(
      session,
      input.prompt,
      input.idempotencyKey,
      session.turnIds.at(-1)
    );
    this.enqueue(created);
    return this.copyTurn(created);
  }
  async cancelTurn(
    command: z.input<(typeof sessionCommandSchemas)["cancel_turn"]>
  ): Promise<TurnStatus> {
    const input = sessionCommandSchemas.cancel_turn.parse(command);
    const turn = this.requireTurn(input.turnId, input.sessionId);
    if (turn.phase === "queued" || turn.phase === "running") {
      const wasRunning = turn.phase === "running";
      const cancelled = { ...this.copyTurn(turn), phase: "cancelled" as const };
      this.commit("turn_cancelled", input.sessionId, turn.turnId, undefined, {
        turn: cancelled
      });
      if (wasRunning)
        await this.cancelRuntime(this.require(input.sessionId), this.turn(turn.turnId));
    }
    return this.copyTurn(this.turn(input.turnId));
  }
  checkpointSession(
    command: z.input<(typeof sessionCommandSchemas)["checkpoint_session"]>
  ): SessionStatus {
    const input = sessionCommandSchemas.checkpoint_session.parse(command);
    this.requireActive(input.sessionId);
    this.commit("session_checkpointed", input.sessionId, undefined, undefined, {
      checkpointRef: input.checkpointRef
    });
    return this.status(input.sessionId);
  }
  resumeSession(command: z.input<(typeof sessionCommandSchemas)["resume_session"]>): SessionStatus {
    const input = sessionCommandSchemas.resume_session.parse(command);
    const session = this.require(input.sessionId);
    if (session.phase === "terminated") throw new Error("terminated session cannot resume");
    this.commit("session_resumed", input.sessionId, undefined, undefined, {});
    this.journalBlocked.delete(input.sessionId);
    this.admitQueued(session);
    return this.status(input.sessionId);
  }
  terminateSession(
    command: z.input<(typeof sessionCommandSchemas)["terminate_session"]>
  ): SessionStatus {
    const input = sessionCommandSchemas.terminate_session.parse(command);
    const session = this.require(input.sessionId);
    if (session.phase === "terminated") return this.status(input.sessionId);
    const activeTurnId = session.activeTurnId;
    const terminated = { ...this.copySession(session), phase: "terminated" as const };
    delete terminated.activeTurnId;
    const turns = session.turnIds.map((turnId) => {
      const turn = this.turn(turnId);
      return turn.phase === "queued" || turn.phase === "running"
        ? { ...this.copyTurn(turn), phase: "cancelled" as const }
        : this.copyTurn(turn);
    });
    this.commit("session_terminated", input.sessionId, undefined, undefined, {
      session: terminated,
      turns
    });
    if (activeTurnId)
      void this.cancelRuntime(this.require(input.sessionId), this.turn(activeTurnId));
    return this.status(input.sessionId);
  }
  streamEvents(command: z.input<(typeof sessionCommandSchemas)["stream_events"]>): AgentdEvent[] {
    const input = sessionCommandSchemas.stream_events.parse(command);
    this.require(input.sessionId);
    return this.journal
      .read()
      .filter((event) => event.sessionId === input.sessionId && event.cursor > input.after);
  }
  getStatus(command: z.input<(typeof sessionCommandSchemas)["get_status"]>): SessionStatus {
    return this.status(sessionCommandSchemas.get_status.parse(command).sessionId);
  }
  getTurn(turnId: string): TurnStatus {
    return this.copyTurn(this.turn(turnId));
  }
  private buildTurn(
    session: SessionStatus,
    prompt: string,
    idempotencyKey: string,
    parentTurnId?: string,
    continuationDepth = 0
  ): TurnStatus {
    const turn: TurnStatus = {
      turnId: this.uniqueId("turn"),
      sessionId: session.sessionId,
      parentTurnId,
      prompt,
      idempotencyKey,
      phase: "queued",
      attemptIds: [],
      recoveryFacts: [],
      continuationDepth
    };
    return turn;
  }
  private enqueue(turn: TurnStatus): void {
    this.commit("turn_enqueued", turn.sessionId, turn.turnId, undefined, { turn });
    this.markReady(this.require(turn.sessionId));
    void this.schedule();
  }
  private admitQueued(session: SessionStatus): void {
    this.markReady(session);
    void this.schedule();
  }
  private markReady(session: SessionStatus): void {
    if (
      session.phase === "active" &&
      !this.journalBlocked.has(session.sessionId) &&
      session.turnIds.some((turnId) => this.turn(turnId).phase === "queued") &&
      !this.ready.includes(session.sessionId)
    )
      this.ready.push(session.sessionId);
  }
  private async schedule(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < this.maxConcurrentSessions && this.ready.length) {
        const sessionId = this.ready.shift()!;
        const session = this.require(sessionId);
        const turn =
          session.phase === "active" && !this.running.has(sessionId)
            ? session.turnIds
                .map((turnId) => this.turn(turnId))
                .find((candidate) => candidate.phase === "queued")
            : undefined;
        if (!turn) continue;
        this.running.add(sessionId);
        void this.execute(session, turn)
          .catch(() => {
            // A journal failure means live state must remain at its last durable event. Stop
            // automatic admission for this session until an explicit successful resume.
            this.journalBlocked.add(sessionId);
          })
          .finally(() => {
            this.running.delete(sessionId);
            this.markReady(session);
            void this.schedule();
          });
      }
    } finally {
      this.draining = false;
    }
  }
  private async execute(session: SessionStatus, turn: TurnStatus): Promise<void> {
    const attemptId = this.uniqueId("attempt");
    const started = {
      ...this.copyTurn(turn),
      phase: "running" as const,
      attemptIds: [...turn.attemptIds, attemptId]
    };
    this.commit("attempt_started", session.sessionId, turn.turnId, attemptId, {
      turn: started,
      conversation: session.conversation
    });
    const input: RuntimeInput = {
      session: this.status(session.sessionId),
      turn: this.copyTurn(turn),
      attemptId
    };
    if (session.conversation) input.conversation = session.conversation;
    let result: RuntimeResult;
    try {
      result = await this.runtime.runTurn(input);
    } catch (error) {
      if (turn.phase !== "running" || session.phase !== "active") return;
      if (
        error instanceof MissingBackendThreadError &&
        session.conversation &&
        !turn.recoveryFacts.includes("backend_thread_missing_fresh_adapter_attempt")
      ) {
        const recoveryFacts = [
          ...turn.recoveryFacts,
          "backend_thread_missing_fresh_adapter_attempt"
        ];
        const retry = {
          ...this.copyTurn(turn),
          phase: "queued" as const,
          recoveryFacts
        };
        this.commit("continuity_degraded", session.sessionId, turn.turnId, attemptId, {
          turn: retry,
          facts: recoveryFacts,
          sessionConversation: null
        });
        this.markReady(session);
        return;
      }
      const fact =
        error instanceof MissingBackendThreadError
          ? "fresh_adapter_attempt_also_missing_no_loop"
          : "interrupted_attempt_requires_reconciliation";
      const interrupted = {
        ...this.copyTurn(turn),
        phase:
          error instanceof MissingBackendThreadError
            ? ("failed" as const)
            : ("reconciliation" as const),
        recoveryFacts: [...turn.recoveryFacts, fact]
      };
      this.commit("attempt_interrupted", session.sessionId, turn.turnId, attemptId, {
        turn: interrupted,
        facts: interrupted.recoveryFacts
      });
      return;
    }
    // Cancellation/termination wins any late result and deliberately leaves conversation unchanged.
    if (turn.phase !== "running" || session.phase !== "active") return;
    this.commit("attempt_completed", session.sessionId, turn.turnId, attemptId, {
      conversation: result.conversation,
      facts: result.facts
    });
    let verified: { outcome: VerifierOutcome; facts: string[] };
    try {
      verified = await this.verifier.verify({ ...input, result });
    } catch {
      if (turn.phase !== "running" || session.phase !== "active") return;
      const recoveryFacts = [
        ...turn.recoveryFacts,
        "verifier_infrastructure_failure_requires_reconciliation"
      ];
      const interrupted = {
        ...this.copyTurn(turn),
        phase: "reconciliation" as const,
        recoveryFacts
      };
      this.commit("verifier_failed", session.sessionId, turn.turnId, attemptId, {
        turn: interrupted,
        facts: recoveryFacts
      });
      return;
    }
    if (turn.phase !== "running" || session.phase !== "active") return;
    if (verified.outcome === "satisfied") {
      const completed = {
        ...this.copyTurn(turn),
        phase: "completed" as const,
        verifierState: "satisfied" as const
      };
      this.commit("verifier_evaluated", session.sessionId, turn.turnId, attemptId, {
        turn: completed,
        outcome: verified.outcome,
        facts: verified.facts
      });
      return;
    }
    if (
      verified.outcome === "escalated" ||
      turn.continuationDepth >= this.maxVerifierContinuations
    ) {
      const escalated = {
        ...this.copyTurn(turn),
        phase: "failed" as const,
        verifierState: "escalated" as const
      };
      this.commit("verifier_escalated", session.sessionId, turn.turnId, attemptId, {
        turn: escalated,
        facts: verified.facts
      });
      return;
    }
    const completed = {
      ...this.copyTurn(turn),
      phase: "completed" as const,
      verifierState: "continue" as const
    };
    const continuation = this.buildTurn(
      session,
      `Continue the prior turn after verifier feedback: ${verified.facts.join("; ")}`,
      `continuation-${turn.turnId}-${turn.continuationDepth + 1}`,
      turn.turnId,
      turn.continuationDepth + 1
    );
    this.commit("verifier_continuation", session.sessionId, turn.turnId, attemptId, {
      sourceTurn: completed,
      continuationTurn: continuation,
      facts: verified.facts
    });
    this.markReady(session);
    void this.schedule();
  }
  private replay(): void {
    let previousCursor = 0;
    for (const event of this.journal.read()) {
      if (event.cursor <= previousCursor)
        throw new Error("journal cursors must be strictly increasing");
      previousCursor = event.cursor;
      this.applyEvent(event);
    }
    // An invocation was durable before it began, but its outcome was not durable at restart.
    // Never re-run it: surface a reconciliation fact for the adapter/authority owner instead.
    for (const turn of this.turns.values()) {
      if (turn.phase === "running") {
        turn.phase = "reconciliation";
        if (!turn.recoveryFacts.includes("interrupted_attempt_requires_reconciliation"))
          turn.recoveryFacts.push("interrupted_attempt_requires_reconciliation");
      }
    }
  }
  private applyEvent(event: AgentdEvent): void {
    this.usedIds.add(event.sessionId);
    if (event.turnId) this.usedIds.add(event.turnId);
    if (event.attemptId) this.usedIds.add(event.attemptId);
    switch (event.kind) {
      case "session_created":
        this.restoreSession(event.payload.session);
        break;
      case "turn_enqueued":
      case "attempt_started":
      case "attempt_interrupted":
      case "turn_cancelled":
      case "turn_finished":
      case "verifier_evaluated":
      case "verifier_escalated":
      case "verifier_failed":
      case "cancellation_failed":
        this.restoreTurn(event.payload.turn);
        break;
      case "verifier_continuation":
        this.restoreTurn(event.payload.sourceTurn);
        this.restoreTurn(event.payload.continuationTurn);
        break;
      case "attempt_completed": {
        const session = this.require(event.sessionId);
        session.conversation = { ...event.payload.conversation };
        break;
      }
      case "continuity_degraded": {
        const session = this.require(event.sessionId);
        if (event.payload.sessionConversation)
          session.conversation = { ...event.payload.sessionConversation };
        else delete session.conversation;
        this.restoreTurn(event.payload.turn);
        break;
      }
      case "session_checkpointed": {
        const session = this.require(event.sessionId);
        session.workspace = {
          ...session.workspace,
          checkpointRef: event.payload.checkpointRef
        };
        break;
      }
      case "session_terminated":
        this.restoreSession(event.payload.session);
        for (const turn of event.payload.turns) this.restoreTurn(turn);
        break;
      case "session_resumed":
        break;
    }
  }
  private restoreSession(session: SessionStatus): void {
    const copy = this.copySession(session);
    this.usedIds.add(copy.sessionId);
    const existing = this.sessions.get(copy.sessionId);
    if (existing) {
      delete existing.conversation;
      delete existing.activeTurnId;
      Object.assign(existing, copy);
    } else {
      this.sessions.set(copy.sessionId, copy);
    }
  }
  private restoreTurn(turn: TurnStatus): void {
    const copy = this.copyTurn(turn);
    this.usedIds.add(copy.turnId);
    for (const attemptId of copy.attemptIds) this.usedIds.add(attemptId);
    const existing = this.turns.get(copy.turnId);
    if (existing) {
      delete existing.parentTurnId;
      delete existing.verifierState;
      Object.assign(existing, copy);
    } else {
      this.turns.set(copy.turnId, copy);
    }
    this.idempotency.set(`${copy.sessionId}:${copy.idempotencyKey}`, copy.turnId);
    const session = this.sessions.get(copy.sessionId);
    if (session) {
      if (!session.turnIds.includes(copy.turnId)) session.turnIds.push(copy.turnId);
      if (copy.phase === "running") session.activeTurnId = copy.turnId;
      else if (session.activeTurnId === copy.turnId) delete session.activeTurnId;
    }
  }
  private commit<K extends keyof typeof eventPayloads>(
    kind: K,
    sessionId: string,
    turnId: string | undefined,
    attemptId: string | undefined,
    payload: z.infer<(typeof eventPayloads)[K]>
  ): AgentdEvent {
    const written = this.journal.append(
      journalEventSchema.parse({
        version: AGENTD_PROTOCOL_VERSION,
        kind,
        sessionId,
        turnId,
        attemptId,
        payload
      })
    );
    this.applyEvent(written);
    return written;
  }
  private uniqueId(prefix: string): string {
    let value: string;
    do value = this.ids.next(prefix);
    while (this.usedIds.has(value));
    return value;
  }
  private async cancelRuntime(session: SessionStatus, turn: TurnStatus): Promise<void> {
    if (!this.runtime.cancelTurn) return;
    try {
      await this.runtime.cancelTurn(session.sessionId, turn.turnId);
    } catch {
      const recoveryFacts = turn.recoveryFacts.includes("runtime_cancel_failed")
        ? [...turn.recoveryFacts]
        : [...turn.recoveryFacts, "runtime_cancel_failed"];
      const failed = { ...this.copyTurn(turn), recoveryFacts };
      try {
        this.commit("cancellation_failed", session.sessionId, turn.turnId, undefined, {
          turn: failed,
          facts: ["runtime_cancel_failed"]
        });
      } catch {
        this.journalBlocked.add(session.sessionId);
      }
    }
  }
  private require(sessionId: string): SessionStatus {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }
  private requireActive(sessionId: string): SessionStatus {
    const session = this.require(sessionId);
    if (session.phase !== "active") throw new Error("session is not active");
    return session;
  }
  private turn(turnId: string): TurnStatus {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`unknown turn ${turnId}`);
    return turn;
  }
  private requireTurn(turnId: string, sessionId: string): TurnStatus {
    const turn = this.turn(turnId);
    if (turn.sessionId !== sessionId) throw new Error("turn is not in session");
    return turn;
  }
  private status(sessionId: string): SessionStatus {
    const session = this.require(sessionId);
    const events = this.journal.read();
    return { ...this.copySession(session), nextCursor: (events.at(-1)?.cursor ?? 0) + 1 };
  }
  private copySession(session: SessionStatus): SessionStatus {
    return {
      ...session,
      workspace: { ...session.workspace },
      conversation: session.conversation && { ...session.conversation },
      turnIds: [...session.turnIds]
    };
  }
  private copyTurn(turn: TurnStatus): TurnStatus {
    return { ...turn, attemptIds: [...turn.attemptIds], recoveryFacts: [...turn.recoveryFacts] };
  }
}
/** Test-only consumer boundary standing in for a future agentd transport. */
export class AgentdHarness {
  constructor(private readonly supervisor: SessionSupervisor) {}
  create_session(command: z.input<typeof createSessionSchema>): SessionStatus {
    return this.supervisor.createSession(command);
  }
  submit_turn(command: z.input<typeof submitTurnSchema>): TurnStatus {
    return this.supervisor.submitTurn(command);
  }
  cancel_turn(
    command: z.input<(typeof sessionCommandSchemas)["cancel_turn"]>
  ): Promise<TurnStatus> {
    return this.supervisor.cancelTurn(command);
  }
  checkpoint_session(
    command: z.input<(typeof sessionCommandSchemas)["checkpoint_session"]>
  ): SessionStatus {
    return this.supervisor.checkpointSession(command);
  }
  resume_session(
    command: z.input<(typeof sessionCommandSchemas)["resume_session"]>
  ): SessionStatus {
    return this.supervisor.resumeSession(command);
  }
  terminate_session(
    command: z.input<(typeof sessionCommandSchemas)["terminate_session"]>
  ): SessionStatus {
    return this.supervisor.terminateSession(command);
  }
  stream_events(command: z.input<(typeof sessionCommandSchemas)["stream_events"]>): AgentdEvent[] {
    return this.supervisor.streamEvents(command);
  }
  get_status(command: z.input<(typeof sessionCommandSchemas)["get_status"]>): SessionStatus {
    return this.supervisor.getStatus(command);
  }
}
