import { createHash } from "node:crypto";

import { z } from "zod";

export const LEGACY_AGENTD_PROTOCOL_VERSION = "agentd/v1" as const;
const opaqueRef = z.string().min(1).max(512);
const id = z.string().min(1).max(128);
const facts = z.array(z.string());
export const tokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative()
  })
  .strict();
export const ZERO_TOKEN_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
} as const;

export const conversationRefSchema = z
  .object({ adapterKind: id, adapterVersion: id, backendThreadRef: opaqueRef })
  .strict();
export const workspaceBindingSchema = z
  .object({
    workspaceRef: opaqueRef,
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    branchRef: opaqueRef.optional(),
    checkpointRef: opaqueRef.optional()
  })
  .strict();
export const createSessionSchema = z
  .object({
    version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
    coordinatorBinding: opaqueRef,
    authorityBinding: opaqueRef,
    workerId: opaqueRef,
    storageLineageId: opaqueRef,
    fenceEpoch: z.number().int().positive(),
    sessionLineageId: id,
    workspace: workspaceBindingSchema
  })
  .strict();
export const submitTurnSchema = z
  .object({
    version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
    sessionId: id,
    prompt: z.string().min(1),
    idempotencyKey: id
  })
  .strict();
export const workerBindingSchema = z
  .object({
    workerId: opaqueRef,
    storageLineageId: opaqueRef,
    fenceEpoch: z.number().int().positive()
  })
  .strict();
export const sessionCommandSchemas = {
  create_session: createSessionSchema,
  submit_turn: submitTurnSchema,
  cancel_turn: z
    .object({ version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION), sessionId: id, turnId: id })
    .strict(),
  checkpoint_session: z
    .object({
      version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
      sessionId: id,
      checkpointRef: opaqueRef
    })
    .strict(),
  resume_session: z
    .object({ version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION), sessionId: id })
    .strict(),
  terminate_session: z
    .object({ version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION), sessionId: id })
    .strict(),
  rebind_session: z
    .object({
      version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
      sessionId: id,
      idempotencyKey: id,
      predecessor: workerBindingSchema,
      successor: workerBindingSchema
    })
    .strict(),
  stream_events: z
    .object({
      version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
      sessionId: id,
      after: z.number().int().nonnegative().default(0)
    })
    .strict(),
  get_status: z
    .object({ version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION), sessionId: id })
    .strict()
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
export const legacyStoredTurnSchema = z
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
    continuationDepth: z.number().int().nonnegative(),
    // Defaults preserve replay compatibility with journals written by session-supervisor 1.0.1.
    tokenUsage: tokenUsageSchema.default(ZERO_TOKEN_USAGE)
  })
  .strict();
export const legacyStoredSessionSchema = z
  .object({
    version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
    sessionId: id,
    coordinatorBinding: opaqueRef,
    authorityBinding: opaqueRef,
    workerId: opaqueRef,
    storageLineageId: opaqueRef,
    fenceEpoch: z.number().int().positive(),
    sessionLineageId: id,
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
  session_created: z.object({ session: legacyStoredSessionSchema }).strict(),
  turn_enqueued: z.object({ turn: legacyStoredTurnSchema }).strict(),
  attempt_started: z
    .object({ turn: legacyStoredTurnSchema, conversation: conversationRefSchema.optional() })
    .strict(),
  attempt_completed: z
    .object({
      conversation: conversationRefSchema,
      facts: facts.optional(),
      tokenUsage: tokenUsageSchema.default(ZERO_TOKEN_USAGE)
    })
    .strict(),
  attempt_interrupted: z.object({ turn: legacyStoredTurnSchema, facts }).strict(),
  turn_cancelled: z.object({ turn: legacyStoredTurnSchema }).strict(),
  turn_finished: z.object({ turn: legacyStoredTurnSchema }).strict(),
  session_checkpointed: z.object({ checkpointRef: opaqueRef }).strict(),
  session_resumed: z.object({}).strict(),
  session_terminated: z
    .object({ session: legacyStoredSessionSchema, turns: z.array(legacyStoredTurnSchema) })
    .strict(),
  session_rebound: z
    .object({
      predecessor: workerBindingSchema,
      successor: workerBindingSchema,
      idempotencyKey: id
    })
    .strict(),
  continuity_degraded: z
    .object({
      turn: legacyStoredTurnSchema,
      facts,
      sessionConversation: conversationRefSchema.nullable()
    })
    .strict(),
  verifier_evaluated: z
    .object({ turn: legacyStoredTurnSchema, outcome: verifierOutcomeSchema, facts })
    .strict(),
  // This is the atomic terminal transition for a continued source turn. Both snapshots are
  // required so a crash cannot leave a completed source without its deterministic child.
  verifier_continuation: z
    .object({
      sourceTurn: legacyStoredTurnSchema,
      continuationTurn: legacyStoredTurnSchema,
      facts
    })
    .strict(),
  cancellation_failed: z.object({ turn: legacyStoredTurnSchema, facts }).strict(),
  verifier_failed: z.object({ turn: legacyStoredTurnSchema, facts }).strict(),
  verifier_escalated: z.object({ turn: legacyStoredTurnSchema, facts }).strict()
} as const;
const eventBase = {
  version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
  cursor: z.number().int().positive(),
  sessionId: id,
  turnId: id.optional(),
  attemptId: id.optional()
};
export type AgentdEvent = {
  [K in keyof typeof eventPayloads]: {
    version: typeof LEGACY_AGENTD_PROTOCOL_VERSION;
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
      version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
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

export const legacyAgentdJournalRowSchema = z
  .object({
    cursor: z.number().int().positive(),
    protocol_version: z.literal(LEGACY_AGENTD_PROTOCOL_VERSION),
    event_json: z.string().min(2),
    event_digest: z.string().regex(/^[0-9a-f]{64}$/),
    recorded_at: z.string().min(1)
  })
  .strict();

export type LegacyAgentdJournalRow = z.infer<typeof legacyAgentdJournalRowSchema>;
export type LegacyAgentdEvent = AgentdEvent;

export type ReadLegacyAgentdEvent = {
  row: LegacyAgentdJournalRow;
  event: LegacyAgentdEvent;
};

export class LegacyAgentdV1JournalReader {
  read(rawRows: readonly unknown[]): ReadLegacyAgentdEvent[] {
    let previousCursor = 0;
    return rawRows.map((rawRow) => {
      const row = legacyAgentdJournalRowSchema.parse(rawRow);
      if (row.cursor <= previousCursor)
        throw new Error("legacy journal cursors must be strictly increasing");
      previousCursor = row.cursor;
      const actualDigest = createHash("sha256").update(row.event_json).digest("hex");
      if (actualDigest !== row.event_digest)
        throw new Error(`legacy journal digest mismatch at cursor ${row.cursor}`);
      let decoded: unknown;
      try {
        decoded = JSON.parse(row.event_json);
      } catch {
        throw new Error(`legacy journal JSON is invalid at cursor ${row.cursor}`);
      }
      const event = agentdEventSchema.parse({ ...(decoded as object), cursor: row.cursor });
      return { row, event };
    });
  }
}
