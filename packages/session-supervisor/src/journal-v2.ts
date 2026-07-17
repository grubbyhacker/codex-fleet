import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type LegacyAgentdEvent,
  type ReadLegacyAgentdEvent,
  legacyStoredSessionSchema,
  legacyStoredTurnSchema
} from "./legacy-agentd-v1.js";
import {
  budgetAccountingEventSchema,
  continuationPromptInputSchema,
  registeredTaskSnapshotSchema,
  registeredVerifierResultSchema,
  sessionReassignedEventSchema
} from "./registered-contracts.js";

export const SESSION_JOURNAL_VERSION = "session-supervisor/journal/v2" as const;
export const LEGACY_AGENTD_V1_MIGRATION_ID =
  "legacy-agentd-v1-to-session-supervisor-journal-v2/1" as const;

const id = z.string().min(1).max(256);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const opaqueRef = z.string().min(1).max(512);

export const canonicalUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    runtimeMs: z.number().int().nonnegative()
  })
  .strict()
  .refine((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens, {
    message: "totalTokens must equal inputTokens + outputTokens"
  });
export type CanonicalUsage = z.infer<typeof canonicalUsageSchema>;

export const migrationFactSchema = z.enum([
  "legacy_transition_imported",
  "legacy_unregistered_task",
  "legacy_unregistered_verifier",
  "legacy_token_usage_defaulted",
  "runtime_measurement_unavailable",
  "interrupted_attempt_requires_reconciliation"
]);
export type MigrationFact = z.infer<typeof migrationFactSchema>;

const sourceRecordSchema = z
  .object({
    protocolVersion: z.literal("agentd/v1"),
    cursor: z.number().int().positive(),
    eventDigest: sha256Hex
  })
  .strict();

const importedStatePayloadSchema = z
  .object({
    sourceKind: id,
    session: legacyStoredSessionSchema,
    turns: z.array(legacyStoredTurnSchema),
    facts: z.array(migrationFactSchema)
  })
  .strict();

const effectAuthorizationSchema = z
  .object({
    effectId: id,
    effectKind: z.enum(["model_turn", "verifier", "adoption", "janitor"]),
    idempotencyKey: id,
    targetRef: opaqueRef,
    task: registeredTaskSnapshotSchema.optional(),
    budgetEvent: budgetAccountingEventSchema.optional()
  })
  .strict()
  .superRefine((authorization, context) => {
    if (authorization.effectKind === "model_turn") {
      if (authorization.budgetEvent?.kind !== "budget_reserved")
        context.addIssue({
          code: "custom",
          message: "model turn authorization requires a budget reservation"
        });
      if (!authorization.task)
        context.addIssue({
          code: "custom",
          message: "model turn authorization requires a registered task"
        });
    } else if (authorization.budgetEvent) {
      context.addIssue({
        code: "custom",
        message: "only a model turn authorization may carry a budget reservation"
      });
    }
    if (authorization.effectKind === "verifier" && !authorization.task)
      context.addIssue({
        code: "custom",
        message: "verifier authorization requires a registered task"
      });
    if (
      (authorization.effectKind === "adoption" || authorization.effectKind === "janitor") &&
      authorization.task
    )
      context.addIssue({
        code: "custom",
        message: "adoption and janitor authorizations cannot carry a registered task"
      });
  });

const effectCompletionSchema = z
  .object({
    effectId: id,
    resultDigest: sha256Hex,
    usage: canonicalUsageSchema.optional()
  })
  .strict();

const completionDecisionSchema = z
  .object({
    task: registeredTaskSnapshotSchema,
    verifierResult: registeredVerifierResultSchema,
    budgetDecision: budgetAccountingEventSchema
  })
  .strict()
  .refine((decision) => decision.budgetDecision.kind === "budget_completion_decided", {
    message: "completion requires an explicit budget decision"
  });

const continuationLinkedSchema = z
  .object({
    sourceTurnId: id,
    continuationTurnId: id,
    input: continuationPromptInputSchema,
    reservation: budgetAccountingEventSchema
  })
  .strict()
  .refine((continuation) => continuation.reservation.kind === "budget_reserved", {
    message: "continuation requires a model turn reservation"
  });

const janitorPlanSchema = z
  .object({
    planId: id,
    repositoryRef: opaqueRef,
    exactTargets: z.array(opaqueRef).min(1).max(64),
    classification: z.enum(["clean_disposable", "dirty", "unreported", "associated", "ambiguous"])
  })
  .strict();

const canonicalEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state_imported"), payload: importedStatePayloadSchema }).strict(),
  z.object({ kind: z.literal("effect_authorized"), payload: effectAuthorizationSchema }).strict(),
  z.object({ kind: z.literal("effect_completed"), payload: effectCompletionSchema }).strict(),
  z
    .object({
      kind: z.literal("reconciliation_required"),
      payload: z
        .object({ scopeRef: opaqueRef, reason: id, relatedEffectId: id.optional() })
        .strict()
    })
    .strict(),
  z.object({ kind: z.literal("completion_decided"), payload: completionDecisionSchema }).strict(),
  z.object({ kind: z.literal("continuation_linked"), payload: continuationLinkedSchema }).strict(),
  z.object({ kind: z.literal("session_adopted"), payload: sessionReassignedEventSchema }).strict(),
  z.object({ kind: z.literal("janitor_planned"), payload: janitorPlanSchema }).strict(),
  z
    .object({
      kind: z.literal("janitor_applied"),
      payload: z
        .object({
          planId: id,
          repositoryRef: opaqueRef,
          exactTargets: z.array(opaqueRef).min(1).max(64)
        })
        .strict()
    })
    .strict()
]);

export const canonicalJournalRecordSchema = z
  .object({
    version: z.literal(SESSION_JOURNAL_VERSION),
    cursor: z.number().int().positive(),
    transactionId: id,
    sessionId: id,
    source: sourceRecordSchema.optional(),
    event: canonicalEventSchema
  })
  .strict();
export type CanonicalJournalRecord = z.infer<typeof canonicalJournalRecordSchema>;

export const journalMigrationManifestSchema = z
  .object({
    sourceProtocolVersion: z.literal("agentd/v1"),
    sourceRowCount: z.number().int().nonnegative(),
    sourceOrderedDigest: sha256Hex,
    targetJournalVersion: z.literal(SESSION_JOURNAL_VERSION),
    targetRowCount: z.number().int().nonnegative(),
    targetOrderedDigest: sha256Hex,
    migrationImplementationId: z.literal(LEGACY_AGENTD_V1_MIGRATION_ID)
  })
  .strict();
export type JournalMigrationManifest = z.infer<typeof journalMigrationManifestSchema>;

export const journalMigrationBundleSchema = z
  .object({
    records: z.array(canonicalJournalRecordSchema),
    manifest: journalMigrationManifestSchema
  })
  .strict()
  .superRefine((bundle, context) => {
    bundle.records.forEach((record, index) => {
      if (record.cursor !== index + 1)
        context.addIssue({
          code: "custom",
          message: "canonical migration cursors must be contiguous"
        });
    });
    if (bundle.manifest.targetRowCount !== bundle.records.length)
      context.addIssue({ code: "custom", message: "migration target row count mismatch" });
    if (orderedRecordDigest(bundle.records) !== bundle.manifest.targetOrderedDigest)
      context.addIssue({ code: "custom", message: "migration target digest mismatch" });
  });
export type JournalMigrationBundle = z.infer<typeof journalMigrationBundleSchema>;

export class LegacyTokenUsageAdapter {
  migrate(
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    },
    wasDefaulted = false
  ): { usage: CanonicalUsage; facts: MigrationFact[] } {
    const canonical = canonicalUsageSchema.parse({ ...usage, runtimeMs: 0 });
    return {
      usage: canonical,
      facts: [
        ...(wasDefaulted ? (["legacy_token_usage_defaulted"] as const) : []),
        "runtime_measurement_unavailable"
      ]
    };
  }
}

export class LegacyDeferredVerifierAdapter {
  reconcile(turn: z.infer<typeof legacyStoredTurnSchema>): z.infer<typeof legacyStoredTurnSchema> {
    const parsed = legacyStoredTurnSchema.parse(turn);
    return legacyStoredTurnSchema.parse({
      ...parsed,
      phase:
        parsed.phase === "cancelled" || parsed.phase === "failed" ? parsed.phase : "reconciliation",
      recoveryFacts: [
        ...new Set([
          ...parsed.recoveryFacts,
          "legacy_unregistered_verifier_requires_reconciliation"
        ])
      ]
    });
  }

  verify(): never {
    throw new Error("LegacyDeferredVerifierAdapter cannot evaluate new work");
  }
}

export function migrateLegacyAgentdV1Journal(
  source: readonly ReadLegacyAgentdEvent[]
): JournalMigrationBundle {
  const sessions = new Map<string, z.infer<typeof legacyStoredSessionSchema>>();
  const turns = new Map<string, z.infer<typeof legacyStoredTurnSchema>>();
  const verifierTurns = new Set<string>();
  const tokenAdapter = new LegacyTokenUsageAdapter();
  const verifierAdapter = new LegacyDeferredVerifierAdapter();
  const records: CanonicalJournalRecord[] = [];

  const restoreSession = (raw: unknown) => {
    const session = legacyStoredSessionSchema.parse(raw);
    sessions.set(session.sessionId, structuredClone(session));
  };
  const restoreTurn = (raw: unknown) => {
    const turn = legacyStoredTurnSchema.parse(raw);
    const existing = turns.get(turn.turnId);
    if (
      existing &&
      (turn.tokenUsage.inputTokens < existing.tokenUsage.inputTokens ||
        turn.tokenUsage.cachedInputTokens < existing.tokenUsage.cachedInputTokens ||
        turn.tokenUsage.outputTokens < existing.tokenUsage.outputTokens ||
        turn.tokenUsage.reasoningOutputTokens < existing.tokenUsage.reasoningOutputTokens ||
        turn.tokenUsage.totalTokens < existing.tokenUsage.totalTokens)
    )
      throw new Error("legacy turn snapshot reduces durable token usage");
    if (existing?.attemptIds.some((attemptId) => !turn.attemptIds.includes(attemptId)))
      throw new Error("legacy turn snapshot drops a durable attempt identity");
    turns.set(turn.turnId, structuredClone(turn));
    const session = sessions.get(turn.sessionId);
    if (session) {
      if (!session.turnIds.includes(turn.turnId)) session.turnIds.push(turn.turnId);
      if (turn.phase === "running") session.activeTurnId = turn.turnId;
      else if (session.activeTurnId === turn.turnId) delete session.activeTurnId;
    }
  };

  for (const item of source) {
    applyLegacyEvent(item.event, sessions, turns, restoreSession, restoreTurn, verifierTurns);
    const session = sessions.get(item.event.sessionId);
    if (!session) throw new Error(`legacy event ${item.event.kind} precedes its session snapshot`);
    const facts = new Set<MigrationFact>([
      "legacy_transition_imported",
      "legacy_unregistered_task"
    ]);
    if (
      item.event.kind === "verifier_evaluated" ||
      item.event.kind === "verifier_continuation" ||
      item.event.kind === "verifier_escalated" ||
      item.event.kind === "verifier_failed"
    )
      facts.add("legacy_unregistered_verifier");
    if (item.event.kind === "attempt_completed") {
      const migrated = tokenAdapter.migrate(item.event.payload.tokenUsage);
      migrated.facts.forEach((fact) => facts.add(fact));
    }
    records.push(
      canonicalJournalRecordSchema.parse({
        version: SESSION_JOURNAL_VERSION,
        cursor: records.length + 1,
        transactionId: `migration:${item.row.cursor}`,
        sessionId: item.event.sessionId,
        source: {
          protocolVersion: item.row.protocol_version,
          cursor: item.row.cursor,
          eventDigest: item.row.event_digest
        },
        event: {
          kind: "state_imported",
          payload: {
            sourceKind: item.event.kind,
            session: structuredClone(session),
            turns: [...turns.values()]
              .filter((turn) => turn.sessionId === item.event.sessionId)
              .sort((left, right) => left.turnId.localeCompare(right.turnId))
              .map((turn) => structuredClone(turn)),
            facts: [...facts].sort()
          }
        }
      })
    );
  }

  for (const turnId of [...verifierTurns].sort()) {
    const turn = turns.get(turnId);
    if (!turn) continue;
    const reconciled = verifierAdapter.reconcile(turn);
    turns.set(turnId, reconciled);
    const session = sessions.get(reconciled.sessionId);
    if (!session) throw new Error("legacy verifier turn has no session");
    if (session.activeTurnId === turnId) delete session.activeTurnId;
    records.push(
      canonicalJournalRecordSchema.parse({
        version: SESSION_JOURNAL_VERSION,
        cursor: records.length + 1,
        transactionId: `migration:reconcile:${turnId}`,
        sessionId: reconciled.sessionId,
        event: {
          kind: "state_imported",
          payload: {
            sourceKind: "migration_reconciliation",
            session: structuredClone(session),
            turns: [...turns.values()]
              .filter((candidate) => candidate.sessionId === reconciled.sessionId)
              .sort((left, right) => left.turnId.localeCompare(right.turnId))
              .map((candidate) => structuredClone(candidate)),
            facts: ["legacy_unregistered_task", "legacy_unregistered_verifier"]
          }
        }
      })
    );
  }

  for (const turn of turns.values()) {
    if (turn.phase !== "running") continue;
    turn.phase = "reconciliation";
    if (!turn.recoveryFacts.includes("interrupted_attempt_requires_reconciliation"))
      turn.recoveryFacts.push("interrupted_attempt_requires_reconciliation");
    const session = sessions.get(turn.sessionId);
    if (!session) throw new Error("legacy running turn has no session");
    if (session.activeTurnId === turn.turnId) delete session.activeTurnId;
    records.push(
      canonicalJournalRecordSchema.parse({
        version: SESSION_JOURNAL_VERSION,
        cursor: records.length + 1,
        transactionId: `migration:interrupt:${turn.turnId}`,
        sessionId: turn.sessionId,
        event: {
          kind: "state_imported",
          payload: {
            sourceKind: "migration_interrupted_attempt",
            session: structuredClone(session),
            turns: [...turns.values()]
              .filter((candidate) => candidate.sessionId === turn.sessionId)
              .sort((left, right) => left.turnId.localeCompare(right.turnId))
              .map((candidate) => structuredClone(candidate)),
            facts: ["legacy_unregistered_task", "interrupted_attempt_requires_reconciliation"]
          }
        }
      })
    );
  }

  const sourceOrderedDigest = digestCanonical(
    source.map(({ row }) => ({ cursor: row.cursor, eventDigest: row.event_digest }))
  );
  const targetOrderedDigest = orderedRecordDigest(records);
  return journalMigrationBundleSchema.parse({
    records,
    manifest: {
      sourceProtocolVersion: "agentd/v1",
      sourceRowCount: source.length,
      sourceOrderedDigest,
      targetJournalVersion: SESSION_JOURNAL_VERSION,
      targetRowCount: records.length,
      targetOrderedDigest,
      migrationImplementationId: LEGACY_AGENTD_V1_MIGRATION_ID
    }
  });
}

function applyLegacyEvent(
  event: LegacyAgentdEvent,
  sessions: Map<string, z.infer<typeof legacyStoredSessionSchema>>,
  turns: Map<string, z.infer<typeof legacyStoredTurnSchema>>,
  restoreSession: (raw: unknown) => void,
  restoreTurn: (raw: unknown) => void,
  verifierTurns: Set<string>
): void {
  switch (event.kind) {
    case "session_created":
      restoreSession(event.payload.session);
      return;
    case "turn_enqueued":
    case "attempt_started":
    case "attempt_interrupted":
    case "turn_cancelled":
    case "turn_finished":
    case "cancellation_failed":
      restoreTurn(event.payload.turn);
      return;
    case "verifier_evaluated":
    case "verifier_escalated":
    case "verifier_failed":
      restoreTurn(event.payload.turn);
      verifierTurns.add(event.payload.turn.turnId);
      return;
    case "verifier_continuation":
      restoreTurn(event.payload.sourceTurn);
      restoreTurn(event.payload.continuationTurn);
      verifierTurns.add(event.payload.sourceTurn.turnId);
      verifierTurns.add(event.payload.continuationTurn.turnId);
      return;
    case "attempt_completed": {
      const session = requireSession(sessions, event.sessionId);
      session.conversation = structuredClone(event.payload.conversation);
      if (event.turnId) {
        const turn = requireTurn(turns, event.turnId);
        turn.tokenUsage = {
          inputTokens: turn.tokenUsage.inputTokens + event.payload.tokenUsage.inputTokens,
          cachedInputTokens:
            turn.tokenUsage.cachedInputTokens + event.payload.tokenUsage.cachedInputTokens,
          outputTokens: turn.tokenUsage.outputTokens + event.payload.tokenUsage.outputTokens,
          reasoningOutputTokens:
            turn.tokenUsage.reasoningOutputTokens + event.payload.tokenUsage.reasoningOutputTokens,
          totalTokens: turn.tokenUsage.totalTokens + event.payload.tokenUsage.totalTokens
        };
      }
      return;
    }
    case "continuity_degraded": {
      const session = requireSession(sessions, event.sessionId);
      if (event.payload.sessionConversation)
        session.conversation = structuredClone(event.payload.sessionConversation);
      else delete session.conversation;
      restoreTurn(event.payload.turn);
      return;
    }
    case "session_checkpointed": {
      const session = requireSession(sessions, event.sessionId);
      session.workspace = {
        ...session.workspace,
        checkpointRef: event.payload.checkpointRef
      };
      return;
    }
    case "session_terminated":
      restoreSession(event.payload.session);
      event.payload.turns.forEach(restoreTurn);
      return;
    case "session_rebound": {
      const session = requireSession(sessions, event.sessionId);
      if (
        session.workerId !== event.payload.predecessor.workerId ||
        session.storageLineageId !== event.payload.predecessor.storageLineageId ||
        session.fenceEpoch !== event.payload.predecessor.fenceEpoch
      )
        throw new Error("legacy session rebound predecessor conflicts during migration");
      Object.assign(session, event.payload.successor);
      return;
    }
    case "session_resumed":
      return;
  }
}

function requireSession(
  sessions: Map<string, z.infer<typeof legacyStoredSessionSchema>>,
  sessionId: string
): z.infer<typeof legacyStoredSessionSchema> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`unknown legacy session: ${sessionId}`);
  return session;
}

function requireTurn(
  turns: Map<string, z.infer<typeof legacyStoredTurnSchema>>,
  turnId: string
): z.infer<typeof legacyStoredTurnSchema> {
  const turn = turns.get(turnId);
  if (!turn) throw new Error(`unknown legacy turn: ${turnId}`);
  return turn;
}

function orderedRecordDigest(records: readonly CanonicalJournalRecord[]): string {
  return digestCanonical(records);
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
