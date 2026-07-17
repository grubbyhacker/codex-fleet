import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type LegacyAgentdEvent,
  type ReadLegacyAgentdEvent,
  legacyStoredSessionSchema,
  legacyStoredTurnSchema
} from "./legacy-agentd-v1.js";
import {
  ContinuationBudgetAccount,
  SessionReassignmentReducer,
  budgetAccountingEventSchema,
  canonicalReasonCodes,
  continuationPromptInputSchema,
  registeredTaskSnapshotSchema,
  registeredVerifierResultSchema,
  sessionReassignedEventSchema,
  type ContinuationBudgetSnapshot,
  type SessionAdoptionBinding
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

export const canonicalConversationSchema = z
  .object({
    adapterKind: id,
    adapterVersion: id,
    backendThreadRef: opaqueRef
  })
  .strict();

export const canonicalSessionOpenedSchema = z
  .object({
    coordinatorBinding: opaqueRef,
    authorityBinding: opaqueRef,
    workerBinding: opaqueRef,
    storageLineageId: opaqueRef,
    fenceEpoch: z.number().int().positive(),
    sessionLineageId: opaqueRef,
    authorityProfile: id,
    authorityProfileVersion: id,
    policyDigest: sha256Hex,
    workspace: z
      .object({
        workspaceRef: opaqueRef,
        uid: z.number().int().nonnegative(),
        gid: z.number().int().nonnegative(),
        branchRef: opaqueRef.optional(),
        checkpointRef: opaqueRef.optional()
      })
      .strict()
  })
  .strict();

const effectAuthorizationSchema = z
  .object({
    effectId: id,
    effectKind: z.enum(["model_turn", "verifier", "adoption", "janitor"]),
    idempotencyKey: id,
    targetRef: opaqueRef,
    turnId: id.optional(),
    parentTurnId: id.optional(),
    fenceEpoch: z.number().int().positive().optional(),
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
    if (authorization.effectKind === "verifier") {
      if (!authorization.task)
        context.addIssue({
          code: "custom",
          message: "verifier authorization requires a registered task"
        });
    }
    if (authorization.parentTurnId && !authorization.turnId)
      context.addIssue({
        code: "custom",
        message: "a parent turn requires a durable turn identity"
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
    runtimeOutcome: z.enum(["completed", "missing_backend_thread"]).optional(),
    resultRef: opaqueRef.optional(),
    conversation: canonicalConversationSchema.optional(),
    usage: canonicalUsageSchema.optional(),
    budgetEvent: budgetAccountingEventSchema.optional()
  })
  .strict()
  .superRefine((completion, context) => {
    if (
      completion.runtimeOutcome === "missing_backend_thread" &&
      (completion.usage || completion.budgetEvent)
    ) {
      context.addIssue({
        code: "custom",
        message: "a missing backend thread cannot report model usage"
      });
      return;
    }
    if (!completion.usage) {
      if (completion.budgetEvent)
        context.addIssue({
          code: "custom",
          message: "a completion without usage cannot update the usage budget"
        });
      return;
    }
    if (!completion.budgetEvent) return;
    if (completion.budgetEvent.kind !== "usage_recorded") return;
    const accounted = completion.budgetEvent.usage;
    if (
      accounted.inputTokens !== completion.usage.inputTokens ||
      accounted.cachedInputTokens !== completion.usage.cachedInputTokens ||
      accounted.outputTokens !== completion.usage.outputTokens ||
      accounted.reasoningOutputTokens !== completion.usage.reasoningOutputTokens ||
      accounted.totalTokens !== completion.usage.totalTokens ||
      accounted.runtimeMs !== completion.usage.runtimeMs
    )
      context.addIssue({
        code: "custom",
        message: "completion usage conflicts with its budget event"
      });
  });

const completionDecisionSchema = z
  .object({
    turnId: id.optional(),
    task: registeredTaskSnapshotSchema,
    verifierResult: registeredVerifierResultSchema,
    budgetDecision: budgetAccountingEventSchema,
    decidedAtMs: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.budgetDecision.kind !== "budget_completion_decided")
      context.addIssue({
        code: "custom",
        message: "completion requires an explicit budget decision"
      });
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

export const canonicalEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state_imported"), payload: importedStatePayloadSchema }).strict(),
  z.object({ kind: z.literal("session_opened"), payload: canonicalSessionOpenedSchema }).strict(),
  z
    .object({
      kind: z.literal("session_checkpointed"),
      payload: z.object({ checkpointRef: opaqueRef }).strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal("session_terminal"),
      payload: z
        .object({
          reason: z.enum(["terminated", "cancelled", "fenced"]),
          relatedEffectId: id.optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal("turn_terminal"),
      payload: z
        .object({
          turnId: id,
          reason: z.enum(["cancelled", "failed", "fenced", "timed_out"]),
          relatedEffectId: id.optional()
        })
        .strict()
    })
    .strict(),
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
  .strict()
  .superRefine((record, context) => {
    if (record.event.kind !== "state_imported" && record.source)
      context.addIssue({
        code: "custom",
        message: "new canonical events cannot claim a legacy source"
      });
    const event = record.event;
    if (event.kind === "state_imported" && event.payload.session.sessionId !== record.sessionId)
      context.addIssue({ code: "custom", message: "imported state belongs to another session" });
    if (
      event.kind === "effect_authorized" &&
      event.payload.budgetEvent &&
      event.payload.budgetEvent.sessionId !== record.sessionId
    )
      context.addIssue({ code: "custom", message: "effect budget belongs to another session" });
    if (
      event.kind === "effect_completed" &&
      event.payload.budgetEvent &&
      event.payload.budgetEvent.sessionId !== record.sessionId
    )
      context.addIssue({ code: "custom", message: "completion budget belongs to another session" });
    if (
      event.kind === "completion_decided" &&
      event.payload.budgetDecision.sessionId !== record.sessionId
    )
      context.addIssue({
        code: "custom",
        message: "completion decision belongs to another session"
      });
    if (
      event.kind === "continuation_linked" &&
      event.payload.reservation.sessionId !== record.sessionId
    )
      context.addIssue({
        code: "custom",
        message: "continuation reservation belongs to another session"
      });
    if (
      event.kind === "session_adopted" &&
      event.payload.fingerprint.logicalSessionId !== record.sessionId
    )
      context.addIssue({ code: "custom", message: "adoption belongs to another session" });
  });
export type CanonicalJournalRecord = z.infer<typeof canonicalJournalRecordSchema>;

type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

export type CanonicalSessionSnapshot = {
  opened?: z.infer<typeof canonicalSessionOpenedSchema>;
  importedState?: z.infer<typeof importedStatePayloadSchema>;
  checkpointRef?: string;
  terminal?: Extract<CanonicalEvent, { kind: "session_terminal" }>["payload"];
  authorizedEffects: Array<Extract<CanonicalEvent, { kind: "effect_authorized" }>["payload"]>;
  completedEffects: Array<Extract<CanonicalEvent, { kind: "effect_completed" }>["payload"]>;
  terminalTurns: Array<Extract<CanonicalEvent, { kind: "turn_terminal" }>["payload"]>;
  completionDecisions: Array<Extract<CanonicalEvent, { kind: "completion_decided" }>["payload"]>;
  continuations: Array<Extract<CanonicalEvent, { kind: "continuation_linked" }>["payload"]>;
  adoptions: Array<Extract<CanonicalEvent, { kind: "session_adopted" }>["payload"]>;
  janitorPlans: Array<Extract<CanonicalEvent, { kind: "janitor_planned" }>["payload"]>;
  janitorApplications: Array<Extract<CanonicalEvent, { kind: "janitor_applied" }>["payload"]>;
  reconciliations: Array<Extract<CanonicalEvent, { kind: "reconciliation_required" }>["payload"]>;
  activeBinding?: SessionAdoptionBinding;
  budgetSnapshots: Record<string, ContinuationBudgetSnapshot>;
};

export type CanonicalJournalSnapshot = {
  nextCursor: number;
  sessions: Record<string, CanonicalSessionSnapshot>;
};

function emptyCanonicalSession(): CanonicalSessionSnapshot {
  return {
    authorizedEffects: [],
    completedEffects: [],
    terminalTurns: [],
    completionDecisions: [],
    continuations: [],
    adoptions: [],
    janitorPlans: [],
    janitorApplications: [],
    reconciliations: [],
    budgetSnapshots: {}
  };
}

/** Pure fail-closed reducer shared by live append and replay consumers. */
export class CanonicalJournalReducer {
  private state: CanonicalJournalSnapshot = {
    nextCursor: 1,
    sessions: {}
  };

  snapshot(): CanonicalJournalSnapshot {
    return structuredClone(this.state);
  }

  apply(raw: CanonicalJournalRecord): CanonicalJournalSnapshot {
    const record = canonicalJournalRecordSchema.parse(raw);
    if (record.cursor !== this.state.nextCursor)
      throw new Error("canonical journal cursor is not the next contiguous cursor");
    const journalNext = structuredClone(this.state);
    const next = structuredClone(journalNext.sessions[record.sessionId] ?? emptyCanonicalSession());
    const event = record.event;
    switch (event.kind) {
      case "state_imported":
        if (
          next.opened ||
          next.authorizedEffects.length > 0 ||
          next.completedEffects.length > 0 ||
          next.completionDecisions.length > 0 ||
          next.continuations.length > 0 ||
          next.adoptions.length > 0 ||
          next.janitorPlans.length > 0
        )
          throw new Error("legacy state cannot be imported after new canonical work");
        next.importedState = event.payload;
        break;
      case "session_opened":
        if (next.opened || next.importedState)
          throw new Error("canonical session state is already initialized");
        next.opened = event.payload;
        next.activeBinding = {
          logicalSessionId: record.sessionId,
          sessionLineage: event.payload.sessionLineageId,
          authorityProfile: event.payload.authorityProfile,
          authorityProfileVersion: event.payload.authorityProfileVersion,
          policyDigest: event.payload.policyDigest,
          storageLineage: event.payload.storageLineageId,
          workerBinding: event.payload.workerBinding,
          fenceEpoch: event.payload.fenceEpoch
        };
        break;
      case "session_checkpointed":
        assertInitialized(next);
        assertNonterminal(next);
        next.checkpointRef = event.payload.checkpointRef;
        break;
      case "session_terminal":
        assertInitialized(next);
        if (next.terminal) throw new Error("canonical session is already terminal");
        next.terminal = event.payload;
        break;
      case "turn_terminal":
        assertInitialized(next);
        if (next.terminalTurns.some((turn) => turn.turnId === event.payload.turnId))
          throw new Error("canonical turn is already terminal");
        next.terminalTurns.push(event.payload);
        break;
      case "effect_authorized":
        assertInitialized(next);
        assertNonterminal(next);
        if (next.authorizedEffects.some((effect) => effect.effectId === event.payload.effectId))
          throw new Error("canonical effect identity is already authorized");
        if (
          next.authorizedEffects.some(
            (effect) => effect.idempotencyKey === event.payload.idempotencyKey
          )
        )
          throw new Error("canonical effect idempotency key is already authorized");
        if (event.payload.turnId || event.payload.fenceEpoch) {
          if (!event.payload.turnId || !event.payload.fenceEpoch)
            throw new Error("canonical runtime effect requires turn and fence identity");
          if (
            event.payload.fenceEpoch !==
            (next.activeBinding?.fenceEpoch ??
              next.opened?.fenceEpoch ??
              next.importedState?.session.fenceEpoch)
          )
            throw new Error("canonical runtime effect is authorized under a stale fence");
          if (
            (event.payload.effectKind === "model_turn" ||
              event.payload.effectKind === "verifier") &&
            !event.payload.task
          )
            throw new Error("canonical runtime effect requires a registered task");
          if (event.payload.effectKind === "model_turn") {
            if (event.payload.budgetEvent?.kind !== "budget_reserved")
              throw new Error("canonical model turn requires a durable reservation");
            if (
              event.payload.idempotencyKey !== event.payload.budgetEvent.reservation.idempotencyKey
            )
              throw new Error("canonical model effect and reservation identities conflict");
            validateRetryAuthorization(next, event.payload);
            validateAndStoreReservation(next, record.sessionId, event.payload);
          }
        } else {
          next.reconciliations.push({
            scopeRef: event.payload.effectId,
            reason: "legacy_canonical_effect_requires_reconciliation",
            relatedEffectId: event.payload.effectId
          });
        }
        next.authorizedEffects.push(event.payload);
        break;
      case "effect_completed": {
        assertInitialized(next);
        assertNonterminal(next);
        const authorization = next.authorizedEffects.find(
          (effect) => effect.effectId === event.payload.effectId
        );
        if (!authorization) throw new Error("canonical effect completion lacks authorization");
        if (
          authorization.fenceEpoch &&
          authorization.fenceEpoch !==
            (next.activeBinding?.fenceEpoch ??
              next.opened?.fenceEpoch ??
              next.importedState?.session.fenceEpoch)
        )
          throw new Error("canonical effect completion is fenced by a newer worker");
        if (
          authorization.turnId &&
          next.terminalTurns.some((turn) => turn.turnId === authorization.turnId)
        )
          throw new Error("canonical turn is terminal");
        if (next.completedEffects.some((effect) => effect.effectId === event.payload.effectId))
          throw new Error("canonical effect is already completed");
        if (
          event.payload.budgetEvent?.kind === "usage_recorded" &&
          event.payload.budgetEvent.attemptId !== event.payload.effectId
        )
          throw new Error("canonical usage is bound to a different effect identity");
        if (authorization.effectKind !== "model_turn" && event.payload.usage)
          throw new Error("only a model turn effect may record model usage");
        if (authorization.effectKind === "model_turn" && authorization.turnId) {
          if (event.payload.runtimeOutcome === "missing_backend_thread") {
            if (event.payload.usage || event.payload.budgetEvent)
              throw new Error("missing backend thread completion cannot record usage");
          } else if (!event.payload.usage || event.payload.budgetEvent?.kind !== "usage_recorded") {
            throw new Error("canonical model completion requires exact atomic usage");
          } else {
            validateAndStoreUsage(next, record.sessionId, authorization, event.payload);
          }
        }
        next.completedEffects.push(event.payload);
        break;
      }
      case "reconciliation_required":
        assertInitialized(next);
        next.reconciliations.push(event.payload);
        break;
      case "completion_decided":
        assertInitialized(next);
        assertNonterminal(next);
        {
          const compatibleAuthorization = next.authorizedEffects.find((effect) =>
            sameTask(effect.task, event.payload.task)
          );
          const modelAuthorization = next.authorizedEffects.find(
            (effect) =>
              effect.effectKind === "model_turn" &&
              effect.turnId === event.payload.turnId &&
              sameTask(effect.task, event.payload.task)
          );
          if (!modelAuthorization && compatibleAuthorization) {
            next.reconciliations.push({
              scopeRef: event.payload.task.taskEvidenceDigest,
              reason: "legacy_canonical_completion_requires_reconciliation"
            });
            break;
          }
          if (!modelAuthorization)
            throw new Error("completion decision lacks matching registered task authorization");
          if (!event.payload.turnId || event.payload.turnId !== modelAuthorization.turnId)
            throw new Error("completion decision conflicts with its model turn");
          const verifierAuthorization = next.authorizedEffects.find(
            (effect) =>
              effect.effectKind === "verifier" &&
              effect.turnId === modelAuthorization.turnId &&
              sameTask(effect.task, event.payload.task)
          );
          const verifierCompletion = verifierAuthorization
            ? next.completedEffects.find(
                (effect) => effect.effectId === verifierAuthorization.effectId
              )
            : undefined;
          if (!verifierAuthorization || !verifierCompletion)
            throw new Error("completion decision lacks a completed registered verifier effect");
          if (
            verifierCompletion.resultDigest !== canonicalValueDigest(event.payload.verifierResult)
          )
            throw new Error("completion decision conflicts with verifier result digest");
          if (
            event.payload.verifierResult.contractDigest !== event.payload.task.contractDigest ||
            event.payload.verifierResult.taskEvidenceDigest !==
              event.payload.task.taskEvidenceDigest
          )
            throw new Error("completion decision carries stale verifier evidence");
          validateBudgetDecision(next, record.sessionId, event.payload);
        }
        next.completionDecisions.push(event.payload);
        break;
      case "continuation_linked":
        assertInitialized(next);
        assertNonterminal(next);
        if (
          next.continuations.some(
            (continuation) =>
              continuation.sourceTurnId === event.payload.sourceTurnId ||
              continuation.continuationTurnId === event.payload.continuationTurnId
          )
        )
          throw new Error("canonical continuation identity is already linked");
        if (!validateAndStoreContinuationReservation(next, record.sessionId, event.payload))
          next.reconciliations.push({
            scopeRef: event.payload.continuationTurnId,
            reason: "legacy_canonical_continuation_requires_reconciliation"
          });
        next.continuations.push(event.payload);
        break;
      case "session_adopted":
        assertInitialized(next);
        assertNonterminal(next);
        validateAndApplyAdoption(next, record.sessionId, event.payload);
        next.adoptions.push(event.payload);
        break;
      case "janitor_planned":
        assertInitialized(next);
        if (next.janitorPlans.some((plan) => plan.planId === event.payload.planId))
          throw new Error("canonical janitor plan identity already exists");
        next.janitorPlans.push(event.payload);
        break;
      case "janitor_applied": {
        const plan = next.janitorPlans.find(
          (candidate) => candidate.planId === event.payload.planId
        );
        if (!plan) throw new Error("canonical janitor application lacks a plan");
        if (
          plan.repositoryRef !== event.payload.repositoryRef ||
          JSON.stringify(plan.exactTargets) !== JSON.stringify(event.payload.exactTargets)
        )
          throw new Error("canonical janitor application widens or changes its plan");
        if (plan.classification !== "clean_disposable")
          throw new Error("canonical janitor application is not authorized by classification");
        if (next.janitorApplications.some((applied) => applied.planId === event.payload.planId))
          throw new Error("canonical janitor plan is already applied");
        next.janitorApplications.push(event.payload);
        break;
      }
    }
    journalNext.sessions[record.sessionId] = next;
    journalNext.nextCursor += 1;
    this.state = journalNext;
    return this.snapshot();
  }
}

export function reduceCanonicalJournal(
  records: readonly CanonicalJournalRecord[]
): CanonicalJournalSnapshot {
  const reducer = new CanonicalJournalReducer();
  for (const record of records) reducer.apply(record);
  return reducer.snapshot();
}

function assertInitialized(snapshot: CanonicalSessionSnapshot): void {
  if (!snapshot.opened && !snapshot.importedState)
    throw new Error("canonical session is not initialized");
}

function assertNonterminal(snapshot: CanonicalSessionSnapshot): void {
  if (snapshot.terminal) throw new Error("canonical session is terminal");
}

type EffectAuthorization = Extract<CanonicalEvent, { kind: "effect_authorized" }>["payload"];
type EffectCompletion = Extract<CanonicalEvent, { kind: "effect_completed" }>["payload"];
type CompletionDecision = Extract<CanonicalEvent, { kind: "completion_decided" }>["payload"];
type ContinuationLink = Extract<CanonicalEvent, { kind: "continuation_linked" }>["payload"];

function taskBudgetKey(task: NonNullable<EffectAuthorization["task"]>): string {
  return `${task.contractDigest}:${task.taskEvidenceDigest}`;
}

function sameTask(
  left: EffectAuthorization["task"],
  right: NonNullable<EffectAuthorization["task"]>
): boolean {
  return !!left && JSON.stringify(left) === JSON.stringify(right);
}

function validateRetryAuthorization(
  snapshot: CanonicalSessionSnapshot,
  authorization: EffectAuthorization
): void {
  const reservation = authorization.budgetEvent;
  if (reservation?.kind !== "budget_reserved") return;
  if (reservation.reservation.retryCause !== "missing_backend_thread") return;
  let predecessor: EffectAuthorization | undefined;
  for (let index = snapshot.authorizedEffects.length - 1; index >= 0; index -= 1) {
    const candidate = snapshot.authorizedEffects[index]!;
    if (
      candidate.effectKind === "model_turn" &&
      candidate.turnId === authorization.turnId &&
      sameTask(candidate.task, authorization.task!) &&
      candidate.budgetEvent?.kind === "budget_reserved" &&
      candidate.budgetEvent.reservation.continuationDepth ===
        reservation.reservation.continuationDepth
    ) {
      predecessor = candidate;
      break;
    }
  }
  const predecessorCompletion = predecessor
    ? snapshot.completedEffects.find((completion) => completion.effectId === predecessor.effectId)
    : undefined;
  if (predecessorCompletion?.runtimeOutcome !== "missing_backend_thread")
    throw new Error("same-depth retry lacks a completed missing backend thread predecessor");
}

function validateAndStoreReservation(
  snapshot: CanonicalSessionSnapshot,
  sessionId: string,
  authorization: EffectAuthorization
): void {
  const task = authorization.task;
  const event = authorization.budgetEvent;
  if (!task || event?.kind !== "budget_reserved")
    throw new Error("canonical model turn reservation is incomplete");
  const key = taskBudgetKey(task);
  const restored = snapshot.budgetSnapshots[key];
  const account = restored
    ? new ContinuationBudgetAccount(task.budget, restored.startedAtMs, restored)
    : new ContinuationBudgetAccount(task.budget, event.snapshot.startedAtMs);
  const expected = account.reserveTurn(
    sessionId,
    event.reservation.idempotencyKey,
    event.reservation.continuationDepth,
    event.reservation.reservedAtMs,
    event.reservation.retryCause
  );
  if (JSON.stringify(expected) !== JSON.stringify(event))
    throw new Error("canonical reservation conflicts with cumulative budget state");
  snapshot.budgetSnapshots[key] = event.snapshot;
}

function validateAndStoreUsage(
  snapshot: CanonicalSessionSnapshot,
  sessionId: string,
  authorization: EffectAuthorization,
  completion: EffectCompletion
): void {
  const task = authorization.task;
  const event = completion.budgetEvent;
  const usage = completion.usage;
  if (!task || !usage || event?.kind !== "usage_recorded")
    throw new Error("canonical model usage is incomplete");
  const key = taskBudgetKey(task);
  const restored = snapshot.budgetSnapshots[key];
  if (!restored) throw new Error("canonical usage lacks cumulative reservation state");
  const account = new ContinuationBudgetAccount(task.budget, restored.startedAtMs, restored);
  const expected = account.recordUsage(sessionId, authorization.effectId, {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
    runtimeMs: usage.runtimeMs
  });
  if (JSON.stringify(expected) !== JSON.stringify(event))
    throw new Error("canonical usage conflicts with cumulative budget state");
  snapshot.budgetSnapshots[key] = event.snapshot;
}

function validateBudgetDecision(
  snapshot: CanonicalSessionSnapshot,
  sessionId: string,
  decision: CompletionDecision
): void {
  const key = taskBudgetKey(decision.task);
  const restored = snapshot.budgetSnapshots[key];
  if (!restored) throw new Error("completion decision lacks cumulative budget state");
  if (decision.decidedAtMs === undefined)
    throw new Error("new completion decision requires a durable decision time");
  const account = new ContinuationBudgetAccount(
    decision.task.budget,
    restored.startedAtMs,
    restored
  );
  const expected = account.decideCompletion(sessionId, decision.decidedAtMs);
  if (JSON.stringify(expected) !== JSON.stringify(decision.budgetDecision))
    throw new Error("completion decision conflicts with cumulative budget state");
  if (
    decision.verifierResult.outcome === "satisfied" &&
    (decision.budgetDecision.kind !== "budget_completion_decided" ||
      decision.budgetDecision.outcome !== "within_budget")
  )
    throw new Error("satisfied completion requires an explicit within-budget decision");
}

function validateAndStoreContinuationReservation(
  snapshot: CanonicalSessionSnapshot,
  sessionId: string,
  continuation: ContinuationLink
): boolean {
  const authorization = snapshot.authorizedEffects.find(
    (effect) =>
      effect.task?.contractDigest === continuation.input.contractDigest &&
      effect.task.taskEvidenceDigest === continuation.input.taskEvidenceDigest
  );
  if (!authorization?.task)
    throw new Error("continuation lacks a matching registered task authorization");
  const task = authorization.task;
  const event = continuation.reservation;
  if (event.kind !== "budget_reserved") throw new Error("continuation lacks a durable reservation");
  const key = taskBudgetKey(authorization.task);
  const restored = snapshot.budgetSnapshots[key];
  if (!authorization.turnId || !authorization.fenceEpoch || !restored) return false;
  if (
    continuation.input.parentTurnId !== continuation.sourceTurnId ||
    continuation.input.continuationDepth !== event.reservation.continuationDepth
  )
    throw new Error("continuation lineage conflicts with its reservation");
  if (
    continuation.input.taskKind !== authorization.task.taskKind ||
    continuation.input.completionContract !== authorization.task.completionContract
  )
    throw new Error("continuation input conflicts with its registered task");
  const verifierAuthorization = snapshot.authorizedEffects.find(
    (effect) =>
      effect.effectKind === "verifier" &&
      effect.turnId === continuation.sourceTurnId &&
      sameTask(effect.task, task)
  );
  const decision = snapshot.completionDecisions.find(
    (candidate) =>
      candidate.turnId === continuation.sourceTurnId &&
      sameTask(candidate.task, task) &&
      (candidate.verifierResult.outcome === "continuation" ||
        candidate.verifierResult.outcome === "missing_or_stale")
  );
  if (
    !verifierAuthorization ||
    !snapshot.completedEffects.some(
      (completion) => completion.effectId === verifierAuthorization.effectId
    ) ||
    !decision
  )
    throw new Error("continuation lacks a completed verifier continuation decision");
  const expectedReasonCodes = canonicalReasonCodes(decision.verifierResult.reasons);
  if (JSON.stringify(continuation.input.reasonCodes) !== JSON.stringify(expectedReasonCodes))
    throw new Error("continuation reason codes conflict with the verifier decision");
  const account = new ContinuationBudgetAccount(task.budget, restored.startedAtMs, restored);
  const expected = account.reserveTurn(
    sessionId,
    event.reservation.idempotencyKey,
    event.reservation.continuationDepth,
    event.reservation.reservedAtMs,
    event.reservation.retryCause
  );
  if (JSON.stringify(expected) !== JSON.stringify(event))
    throw new Error("continuation reservation conflicts with cumulative budget state");
  snapshot.budgetSnapshots[key] = event.snapshot;
  return true;
}

function validateAndApplyAdoption(
  snapshot: CanonicalSessionSnapshot,
  sessionId: string,
  event: Extract<CanonicalEvent, { kind: "session_adopted" }>["payload"]
): void {
  let current = snapshot.activeBinding;
  if (!current) {
    const imported = snapshot.importedState?.session;
    if (!imported) throw new Error("canonical adoption lacks a current session binding");
    if (
      event.predecessor.logicalSessionId !== sessionId ||
      event.predecessor.sessionLineage !== imported.sessionLineageId ||
      event.predecessor.storageLineage !== imported.storageLineageId ||
      event.predecessor.workerBinding !== imported.workerId ||
      event.predecessor.fenceEpoch !== imported.fenceEpoch
    )
      throw new Error("canonical adoption conflicts with imported session binding");
    current = event.predecessor;
  }
  const reducer = new SessionReassignmentReducer(current);
  reducer.apply(event);
  snapshot.activeBinding = reducer.current();
}

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

  const sourceOrderedDigest = canonicalValueDigest(
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
  return canonicalValueDigest(records);
}

export function canonicalValueDigest(value: unknown): string {
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
