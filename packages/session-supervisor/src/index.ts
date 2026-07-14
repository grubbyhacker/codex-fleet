import { z } from "zod";

export const AGENTD_PROTOCOL_VERSION = "agentd/v1" as const;
const opaqueRef = z.string().min(1).max(512);
const id = z.string().min(1).max(128);

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

export const agentdEventSchema = z
  .object({
    version: z.literal(AGENTD_PROTOCOL_VERSION),
    cursor: z.number().int().positive(),
    kind: id,
    sessionId: id,
    turnId: id.optional(),
    attemptId: id.optional(),
    facts: z.array(z.string()).optional()
  })
  .strict();
export const sessionStatusSchema = z
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

export type ConversationRef = z.infer<typeof conversationRefSchema>;
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;
export type SessionPhase = "active" | "terminated";
export type TurnPhase =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "reconciliation";
export type VerifierOutcome = "satisfied" | "continue" | "escalated";
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type TurnStatus = {
  turnId: string;
  sessionId: string;
  parentTurnId?: string;
  prompt: string;
  idempotencyKey: string;
  phase: TurnPhase;
  attemptIds: string[];
  verifierState?: VerifierOutcome;
  recoveryFacts: string[];
};
export type AgentdEvent = z.infer<typeof agentdEventSchema>;
type JournalEvent = Omit<AgentdEvent, "cursor"> & {
  cursor?: number;
  payload?: Record<string, unknown>;
};

export interface SessionJournal {
  append(event: JournalEvent): AgentdEvent;
  read(): AgentdEvent[];
}

/** Test-only journal: production storage must preserve append ordering before invoking a runtime. */
export class InMemorySessionJournal implements SessionJournal {
  private events: AgentdEvent[] = [];
  append(event: JournalEvent): AgentdEvent {
    const written = { ...event, version: AGENTD_PROTOCOL_VERSION, cursor: this.events.length + 1 };
    this.events.push(written);
    return written;
  }
  read(): AgentdEvent[] {
    return [...this.events];
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

type StoredSession = SessionStatus;
type StoredTurn = TurnStatus;

/** Backend-neutral session supervisor. It owns only logical session state; adapters own provider auth and execution. */
export class SessionSupervisor {
  private sessions = new Map<string, StoredSession>();
  private turns = new Map<string, StoredTurn>();
  private readonly idempotency = new Map<string, string>();
  private readonly running = new Set<string>();
  constructor(
    private readonly journal: SessionJournal,
    private readonly runtime: RuntimeAdapter,
    private readonly verifier: CompletionVerifier,
    private readonly ids: Ids = new SequenceIds(),
    private readonly maxVerifierContinuations = 1
  ) {
    this.replay();
  }

  createSession(command: z.input<typeof createSessionSchema>): SessionStatus {
    const input = createSessionSchema.parse(command);
    const sessionId = this.ids.next("session");
    const session: StoredSession = {
      version: AGENTD_PROTOCOL_VERSION,
      sessionId,
      coordinatorBinding: input.coordinatorBinding,
      authorityBinding: input.authorityBinding,
      workspace: input.workspace,
      phase: "active",
      turnIds: [],
      nextCursor: 1
    };
    this.sessions.set(sessionId, session);
    this.write("session_created", sessionId, undefined, undefined, { session });
    return this.status(sessionId);
  }
  submitTurn(command: z.input<typeof submitTurnSchema>): TurnStatus {
    const input = submitTurnSchema.parse(command);
    const session = this.requireActive(input.sessionId);
    const key = `${input.sessionId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return this.turn(existing);
    const previous = session.turnIds.at(-1);
    const turnId = this.ids.next("turn");
    const turn: StoredTurn = {
      turnId,
      sessionId: input.sessionId,
      parentTurnId: previous,
      prompt: input.prompt,
      idempotencyKey: input.idempotencyKey,
      phase: "queued",
      attemptIds: [],
      recoveryFacts: []
    };
    this.turns.set(turnId, turn);
    this.idempotency.set(key, turnId);
    session.turnIds.push(turnId);
    this.write("turn_enqueued", input.sessionId, turnId, undefined, { turn });
    void this.drain(input.sessionId);
    return this.copyTurn(turn);
  }
  async cancelTurn(
    command: z.input<(typeof sessionCommandSchemas)["cancel_turn"]>
  ): Promise<TurnStatus> {
    const input = sessionCommandSchemas.cancel_turn.parse(command);
    const turn = this.requireTurn(input.turnId, input.sessionId);
    if (turn.phase === "running") await this.runtime.cancelTurn?.(input.sessionId, input.turnId);
    if (turn.phase === "queued" || turn.phase === "running") {
      turn.phase = "cancelled";
      this.write("turn_cancelled", input.sessionId, turn.turnId);
    }
    return this.copyTurn(turn);
  }
  checkpointSession(
    command: z.input<(typeof sessionCommandSchemas)["checkpoint_session"]>
  ): SessionStatus {
    const input = sessionCommandSchemas.checkpoint_session.parse(command);
    const session = this.requireActive(input.sessionId);
    session.workspace = { ...session.workspace, checkpointRef: input.checkpointRef };
    this.write("session_checkpointed", input.sessionId, undefined, undefined, {
      checkpointRef: input.checkpointRef
    });
    return this.status(input.sessionId);
  }
  resumeSession(command: z.input<(typeof sessionCommandSchemas)["resume_session"]>): SessionStatus {
    const input = sessionCommandSchemas.resume_session.parse(command);
    const session = this.require(input.sessionId);
    if (session.phase === "terminated") throw new Error("terminated session cannot resume");
    this.write("session_resumed", input.sessionId);
    return this.status(input.sessionId);
  }
  terminateSession(
    command: z.input<(typeof sessionCommandSchemas)["terminate_session"]>
  ): SessionStatus {
    const input = sessionCommandSchemas.terminate_session.parse(command);
    const session = this.require(input.sessionId);
    session.phase = "terminated";
    this.write("session_terminated", input.sessionId);
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

  private async drain(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    const session = this.require(sessionId);
    if (session.phase !== "active") return;
    const turn = session.turnIds
      .map((turnId) => this.turn(turnId))
      .find((candidate) => candidate.phase === "queued");
    if (!turn) return;
    this.running.add(sessionId);
    session.activeTurnId = turn.turnId;
    turn.phase = "running";
    try {
      await this.execute(session, turn);
    } finally {
      this.running.delete(sessionId);
      delete session.activeTurnId;
      void this.drain(sessionId);
    }
  }
  private async execute(session: StoredSession, turn: StoredTurn): Promise<void> {
    let continuation = 0;
    let freshFallbackUsed = false;
    while (true) {
      const attemptId = this.ids.next("attempt");
      turn.attemptIds.push(attemptId);
      this.write("attempt_started", session.sessionId, turn.turnId, attemptId, {
        conversation: session.conversation
      });
      const input = {
        session: this.status(session.sessionId),
        turn: this.copyTurn(turn),
        attemptId,
        conversation: session.conversation
      };
      let result: RuntimeResult;
      try {
        result = await this.runtime.runTurn(input);
      } catch (error) {
        if (
          error instanceof MissingBackendThreadError &&
          session.conversation &&
          !freshFallbackUsed
        ) {
          freshFallbackUsed = true;
          turn.recoveryFacts.push("backend_thread_missing_fresh_adapter_attempt");
          session.conversation = undefined;
          this.write("continuity_degraded", session.sessionId, turn.turnId, attemptId, {
            facts: [...turn.recoveryFacts]
          });
          continue;
        }
        turn.phase = error instanceof MissingBackendThreadError ? "failed" : "reconciliation";
        turn.recoveryFacts.push(
          error instanceof MissingBackendThreadError
            ? "fresh_adapter_attempt_also_missing_no_loop"
            : "interrupted_attempt_requires_reconciliation"
        );
        this.write("attempt_interrupted", session.sessionId, turn.turnId, attemptId, {
          facts: turn.recoveryFacts
        });
        this.write("turn_finished", session.sessionId, turn.turnId, attemptId, { turn });
        return;
      }
      session.conversation = result.conversation;
      this.write("attempt_completed", session.sessionId, turn.turnId, attemptId, {
        conversation: result.conversation,
        facts: result.facts
      });
      const verified = await this.verifier.verify({ ...input, result });
      turn.verifierState = verified.outcome;
      this.write("verifier_evaluated", session.sessionId, turn.turnId, attemptId, {
        outcome: verified.outcome,
        facts: verified.facts
      });
      if (verified.outcome === "satisfied") {
        turn.phase = "completed";
        this.write("turn_finished", session.sessionId, turn.turnId, attemptId, { turn });
        return;
      }
      if (verified.outcome === "escalated" || continuation >= this.maxVerifierContinuations) {
        turn.phase = "failed";
        turn.verifierState = "escalated";
        this.write("verifier_escalated", session.sessionId, turn.turnId, attemptId, {
          facts: verified.facts
        });
        this.write("turn_finished", session.sessionId, turn.turnId, attemptId, { turn });
        return;
      }
      continuation += 1;
      this.write("verifier_continuation", session.sessionId, turn.turnId, attemptId, {
        facts: verified.facts
      });
    }
  }
  private replay(): void {
    for (const event of this.journal.read()) {
      const payload = (event as JournalEvent).payload;
      if (event.kind === "session_created" && payload?.session)
        this.sessions.set(event.sessionId, payload.session as StoredSession);
      if (event.kind === "turn_enqueued" && payload?.turn) {
        const turn = payload.turn as StoredTurn;
        this.turns.set(turn.turnId, turn);
        this.idempotency.set(`${turn.sessionId}:${turn.idempotencyKey}`, turn.turnId);
        const session = this.sessions.get(turn.sessionId);
        if (session && !session.turnIds.includes(turn.turnId)) session.turnIds.push(turn.turnId);
      }
      if (event.kind === "attempt_completed" && payload?.conversation) {
        const session = this.sessions.get(event.sessionId);
        if (session) session.conversation = payload.conversation as ConversationRef;
      }
      if (event.kind === "turn_finished" && payload?.turn)
        this.turns.set(event.turnId ?? "", payload.turn as StoredTurn);
      if (event.kind === "session_checkpointed") {
        const session = this.sessions.get(event.sessionId);
        if (session && typeof payload?.checkpointRef === "string")
          session.workspace = { ...session.workspace, checkpointRef: payload.checkpointRef };
      }
    }
  }
  private write(
    kind: string,
    sessionId: string,
    turnId?: string,
    attemptId?: string,
    payload?: Record<string, unknown>
  ): void {
    this.journal.append({
      version: AGENTD_PROTOCOL_VERSION,
      kind,
      sessionId,
      turnId,
      attemptId,
      facts: Array.isArray(payload?.facts) ? (payload.facts as string[]) : undefined,
      payload
    });
  }
  private require(idValue: string): StoredSession {
    const session = this.sessions.get(idValue);
    if (!session) throw new Error(`unknown session ${idValue}`);
    return session;
  }
  private requireActive(idValue: string): StoredSession {
    const session = this.require(idValue);
    if (session.phase !== "active") throw new Error("session is not active");
    return session;
  }
  private turn(idValue: string): StoredTurn {
    const turn = this.turns.get(idValue);
    if (!turn) throw new Error(`unknown turn ${idValue}`);
    return turn;
  }
  private requireTurn(turnId: string, sessionId: string): StoredTurn {
    const turn = this.turn(turnId);
    if (turn.sessionId !== sessionId) throw new Error("turn is not in session");
    return turn;
  }
  private status(sessionId: string): SessionStatus {
    const session = this.require(sessionId);
    return {
      ...session,
      workspace: { ...session.workspace },
      conversation: session.conversation && { ...session.conversation },
      turnIds: [...session.turnIds],
      nextCursor: this.journal.read().length + 1
    };
  }
  private copyTurn(turn: StoredTurn): TurnStatus {
    return { ...turn, attemptIds: [...turn.attemptIds], recoveryFacts: [...turn.recoveryFacts] };
  }
}

/** Test-only consumer surface standing in for a future agentd transport. */
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
