import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const lineageId = z.string().regex(/^[0-9a-f]{32}$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const opaqueRef = z.string().min(1).max(512);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const continuationBudgetPolicySchema = z
  .object({
    maxContinuations: z.number().int().nonnegative(),
    maxModelTurns: z.number().int().positive(),
    wallClockDeadlineMs: z.number().int().positive(),
    maxTotalTokens: z.number().int().nonnegative(),
    maxRuntimeMs: z.number().int().nonnegative(),
    perTurnTimeoutMs: z.number().int().positive()
  })
  .strict();
export type ContinuationBudgetPolicy = z.infer<typeof continuationBudgetPolicySchema>;

export const usageAccountingSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    runtimeMs: z.number().int().nonnegative()
  })
  .strict()
  .refine((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens, {
    message: "totalTokens must equal inputTokens + outputTokens"
  });
export type UsageAccounting = z.infer<typeof usageAccountingSchema>;

const budgetReservationSchema = z
  .object({
    idempotencyKey: id,
    turnOrdinal: z.number().int().positive(),
    continuationDepth: z.number().int().nonnegative(),
    reservedAtMs: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive()
  })
  .strict();
const usageRecordSchema = z.object({ attemptId: id, usage: usageAccountingSchema }).strict();
export const continuationBudgetSnapshotSchema = z
  .object({
    policy: continuationBudgetPolicySchema,
    startedAtMs: z.number().int().nonnegative(),
    deadlineAtMs: z.number().int().positive(),
    reservations: z.array(budgetReservationSchema),
    usageRecords: z.array(usageRecordSchema),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    runtimeMs: z.number().int().nonnegative()
  })
  .strict();
export type ContinuationBudgetSnapshot = z.infer<typeof continuationBudgetSnapshotSchema>;

export const budgetAccountingEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("budget_reserved"),
      sessionId: id,
      reservation: budgetReservationSchema,
      snapshot: continuationBudgetSnapshotSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("usage_recorded"),
      sessionId: id,
      attemptId: id,
      usage: usageAccountingSchema,
      snapshot: continuationBudgetSnapshotSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("budget_exhausted"),
      sessionId: id,
      reason: z.enum([
        "continuation_limit",
        "model_turn_limit",
        "wall_clock_deadline",
        "token_limit",
        "runtime_limit"
      ]),
      snapshot: continuationBudgetSnapshotSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("budget_completion_decided"),
      sessionId: id,
      outcome: z.enum(["within_budget", "escalated"]),
      reason: z.enum(["wall_clock_deadline", "token_limit", "runtime_limit"]).optional(),
      snapshot: continuationBudgetSnapshotSchema
    })
    .strict()
]);
export type BudgetAccountingEvent = z.infer<typeof budgetAccountingEventSchema>;

export class ContinuationBudgetAccount {
  private snapshotValue: ContinuationBudgetSnapshot;

  constructor(
    policy: ContinuationBudgetPolicy,
    startedAtMs: number,
    restored?: ContinuationBudgetSnapshot
  ) {
    const parsedPolicy = continuationBudgetPolicySchema.parse(policy);
    if (restored) {
      const parsedRestored = continuationBudgetSnapshotSchema.parse(restored);
      if (!sameBudgetPolicy(parsedPolicy, parsedRestored.policy))
        throw new Error("restored budget policy does not match compiled policy");
      if (parsedRestored.startedAtMs !== startedAtMs)
        throw new Error("restored budget start does not match requested account");
      if (parsedRestored.deadlineAtMs !== startedAtMs + parsedPolicy.wallClockDeadlineMs)
        throw new Error("restored budget deadline does not match compiled policy");
      this.snapshotValue = parsedRestored;
    } else {
      this.snapshotValue = continuationBudgetSnapshotSchema.parse({
        policy: parsedPolicy,
        startedAtMs,
        deadlineAtMs: startedAtMs + parsedPolicy.wallClockDeadlineMs,
        reservations: [],
        usageRecords: [],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        runtimeMs: 0
      });
    }
  }

  snapshot(): ContinuationBudgetSnapshot {
    return continuationBudgetSnapshotSchema.parse(this.snapshotValue);
  }

  reserveTurn(
    sessionId: string,
    idempotencyKey: string,
    continuationDepth: number,
    nowMs: number
  ): BudgetAccountingEvent {
    const existing = this.snapshotValue.reservations.find(
      (reservation) => reservation.idempotencyKey === idempotencyKey
    );
    if (existing) {
      if (existing.continuationDepth !== continuationDepth)
        throw new Error("conflicting budget reservation replay");
      return budgetAccountingEventSchema.parse({
        kind: "budget_reserved",
        sessionId,
        reservation: existing,
        snapshot: this.snapshotValue
      });
    }
    const exhausted = this.exhaustionReason(continuationDepth, nowMs);
    if (exhausted)
      return budgetAccountingEventSchema.parse({
        kind: "budget_exhausted",
        sessionId,
        reason: exhausted,
        snapshot: this.snapshotValue
      });
    const reservation = budgetReservationSchema.parse({
      idempotencyKey,
      turnOrdinal: this.snapshotValue.reservations.length + 1,
      continuationDepth,
      reservedAtMs: nowMs,
      timeoutMs: Math.min(
        this.snapshotValue.policy.perTurnTimeoutMs,
        this.snapshotValue.deadlineAtMs - nowMs,
        this.snapshotValue.policy.maxRuntimeMs - this.snapshotValue.runtimeMs
      )
    });
    this.snapshotValue.reservations.push(reservation);
    return budgetAccountingEventSchema.parse({
      kind: "budget_reserved",
      sessionId,
      reservation,
      snapshot: this.snapshotValue
    });
  }

  recordUsage(sessionId: string, attemptId: string, usage: UsageAccounting): BudgetAccountingEvent {
    const parsed = usageAccountingSchema.parse(usage);
    const existing = this.snapshotValue.usageRecords.find(
      (record) => record.attemptId === attemptId
    );
    if (existing) {
      if (JSON.stringify(existing.usage) !== JSON.stringify(parsed))
        throw new Error("conflicting usage replay");
      return budgetAccountingEventSchema.parse({
        kind: "usage_recorded",
        sessionId,
        attemptId,
        usage: existing.usage,
        snapshot: this.snapshotValue
      });
    }
    this.snapshotValue.usageRecords.push({ attemptId, usage: parsed });
    this.snapshotValue.inputTokens += parsed.inputTokens;
    this.snapshotValue.outputTokens += parsed.outputTokens;
    this.snapshotValue.totalTokens += parsed.totalTokens;
    this.snapshotValue.runtimeMs += parsed.runtimeMs;
    return budgetAccountingEventSchema.parse({
      kind: "usage_recorded",
      sessionId,
      attemptId,
      usage: parsed,
      snapshot: this.snapshotValue
    });
  }

  decideCompletion(sessionId: string, nowMs: number): BudgetAccountingEvent {
    const reason =
      nowMs >= this.snapshotValue.deadlineAtMs
        ? "wall_clock_deadline"
        : this.snapshotValue.totalTokens > this.snapshotValue.policy.maxTotalTokens
          ? "token_limit"
          : this.snapshotValue.runtimeMs > this.snapshotValue.policy.maxRuntimeMs
            ? "runtime_limit"
            : undefined;
    return budgetAccountingEventSchema.parse({
      kind: "budget_completion_decided",
      sessionId,
      outcome: reason ? "escalated" : "within_budget",
      reason,
      snapshot: this.snapshotValue
    });
  }

  private exhaustionReason(
    continuationDepth: number,
    nowMs: number
  ): Extract<BudgetAccountingEvent, { kind: "budget_exhausted" }>["reason"] | undefined {
    if (continuationDepth > this.snapshotValue.policy.maxContinuations) return "continuation_limit";
    if (this.snapshotValue.reservations.length >= this.snapshotValue.policy.maxModelTurns)
      return "model_turn_limit";
    if (nowMs >= this.snapshotValue.deadlineAtMs) return "wall_clock_deadline";
    if (this.snapshotValue.totalTokens >= this.snapshotValue.policy.maxTotalTokens)
      return "token_limit";
    if (this.snapshotValue.runtimeMs >= this.snapshotValue.policy.maxRuntimeMs)
      return "runtime_limit";
    return undefined;
  }
}

function sameBudgetPolicy(
  expected: ContinuationBudgetPolicy,
  restored: ContinuationBudgetPolicy
): boolean {
  return (
    expected.maxContinuations === restored.maxContinuations &&
    expected.maxModelTurns === restored.maxModelTurns &&
    expected.wallClockDeadlineMs === restored.wallClockDeadlineMs &&
    expected.maxTotalTokens === restored.maxTotalTokens &&
    expected.maxRuntimeMs === restored.maxRuntimeMs &&
    expected.perTurnTimeoutMs === restored.perTurnTimeoutMs
  );
}

export const registeredTaskSnapshotSchema = z
  .object({
    taskKind: id,
    completionContract: id,
    verifierId: id,
    contractDigest: digest,
    parameters: jsonObjectSchema,
    taskEvidenceDigest: digest,
    budget: continuationBudgetPolicySchema
  })
  .strict();
export type RegisteredTaskSnapshot = z.infer<typeof registeredTaskSnapshotSchema>;

export const verifierReasonSchema = z
  .object({ code: id, evidenceRef: opaqueRef.optional() })
  .strict();
export const registeredVerifierResultSchema = z
  .object({
    outcome: z.enum(["satisfied", "missing_or_stale", "continuation", "escalated"]),
    contractDigest: digest,
    taskEvidenceDigest: digest,
    headRevision: opaqueRef,
    reasons: z.array(verifierReasonSchema).max(32),
    evidenceRefs: z.array(opaqueRef).min(1).max(64)
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === "satisfied" && result.reasons.length > 0)
      context.addIssue({ code: "custom", message: "satisfied outcome cannot carry reasons" });
    if (result.outcome !== "satisfied" && result.reasons.length === 0)
      context.addIssue({ code: "custom", message: "non-satisfied outcome requires a reason" });
  });
export type RegisteredVerifierResult = z.infer<typeof registeredVerifierResultSchema>;

export const continuationPromptInputSchema = z
  .object({
    taskKind: id,
    completionContract: id,
    contractDigest: digest,
    taskEvidenceDigest: digest,
    parentTurnId: id,
    continuationDepth: z.number().int().positive(),
    reasonCodes: z.array(id).min(1).max(32)
  })
  .strict();
export type ContinuationPromptInput = z.infer<typeof continuationPromptInputSchema>;

export type RegisteredTaskDefinition = {
  taskKind: string;
  completionContract: string;
  verifierId: string;
  contractDigest: string;
  parameterSchema: z.ZodObject;
  allowedReasonCodes: readonly string[];
  budget: ContinuationBudgetPolicy;
};

export class RegisteredTaskRegistry {
  private readonly definitions = new Map<string, RegisteredTaskDefinition>();

  constructor(definitions: readonly RegisteredTaskDefinition[]) {
    for (const definition of definitions) {
      const identifiers = z
        .object({ taskKind: id, completionContract: id, verifierId: id, contractDigest: digest })
        .strict()
        .parse({
          taskKind: definition.taskKind,
          completionContract: definition.completionContract,
          verifierId: definition.verifierId,
          contractDigest: definition.contractDigest
        });
      if (this.definitions.has(identifiers.taskKind))
        throw new Error("duplicate registered task kind");
      const allowedReasonCodes = [
        ...new Set(definition.allowedReasonCodes.map((code) => id.parse(code)))
      ];
      if (allowedReasonCodes.length === 0)
        throw new Error("registered verifier needs reason codes");
      this.definitions.set(identifiers.taskKind, {
        ...identifiers,
        parameterSchema: definition.parameterSchema.strict(),
        allowedReasonCodes,
        budget: continuationBudgetPolicySchema.parse(definition.budget)
      });
    }
  }

  resolve(
    taskKind: string,
    parameters: unknown,
    taskEvidenceDigest: string
  ): RegisteredTaskSnapshot {
    const definition = this.requireDefinition(taskKind);
    return registeredTaskSnapshotSchema.parse({
      taskKind: definition.taskKind,
      completionContract: definition.completionContract,
      verifierId: definition.verifierId,
      contractDigest: definition.contractDigest,
      parameters: definition.parameterSchema.parse(parameters),
      taskEvidenceDigest,
      budget: definition.budget
    });
  }

  validateResult(
    task: RegisteredTaskSnapshot,
    result: unknown,
    budgetDecision?: BudgetAccountingEvent
  ): RegisteredVerifierResult {
    const definition = this.requireDefinition(task.taskKind);
    const parsed = registeredVerifierResultSchema.parse(result);
    if (
      task.completionContract !== definition.completionContract ||
      task.verifierId !== definition.verifierId ||
      task.contractDigest !== definition.contractDigest
    )
      throw new Error("registered task snapshot does not match compiled registry");
    if (
      parsed.contractDigest !== task.contractDigest ||
      parsed.taskEvidenceDigest !== task.taskEvidenceDigest
    )
      throw new Error("stale verifier evidence");
    for (const reason of parsed.reasons)
      if (!definition.allowedReasonCodes.includes(reason.code))
        throw new Error(`unregistered verifier reason: ${reason.code}`);
    if (
      parsed.outcome === "satisfied" &&
      (budgetDecision?.kind !== "budget_completion_decided" ||
        budgetDecision.outcome !== "within_budget")
    )
      throw new Error("satisfied completion requires an explicit within-budget decision");
    return parsed;
  }

  continuationInput(
    task: RegisteredTaskSnapshot,
    result: RegisteredVerifierResult,
    parentTurnId: string,
    continuationDepth: number
  ): ContinuationPromptInput {
    if (result.outcome !== "missing_or_stale" && result.outcome !== "continuation")
      throw new Error("verifier outcome cannot continue");
    const reasonCodes = [...new Set(result.reasons.map((reason) => reason.code))].sort();
    return continuationPromptInputSchema.parse({
      taskKind: task.taskKind,
      completionContract: task.completionContract,
      contractDigest: task.contractDigest,
      taskEvidenceDigest: task.taskEvidenceDigest,
      parentTurnId,
      continuationDepth,
      reasonCodes
    });
  }

  renderContinuation(input: ContinuationPromptInput): string {
    const parsed = continuationPromptInputSchema.parse(input);
    return [
      `Continue registered task ${parsed.taskKind}.`,
      `Completion contract: ${parsed.completionContract}.`,
      `Contract digest: ${parsed.contractDigest}.`,
      `Task evidence digest: ${parsed.taskEvidenceDigest}.`,
      `Parent turn: ${parsed.parentTurnId}.`,
      `Continuation: ${parsed.continuationDepth}.`,
      `Required reason codes: ${[...parsed.reasonCodes].sort().join(", ")}.`
    ].join("\n");
  }

  private requireDefinition(taskKind: string): RegisteredTaskDefinition {
    const definition = this.definitions.get(id.parse(taskKind));
    if (!definition) throw new Error(`unregistered task kind: ${taskKind}`);
    return definition;
  }
}

export const sessionAdoptionBindingSchema = z
  .object({
    logicalSessionId: id,
    sessionLineage: lineageId,
    authorityProfile: id,
    authorityProfileVersion: id,
    policyDigest: sha256Hex,
    storageLineage: lineageId,
    workerBinding: opaqueRef,
    fenceEpoch: z.number().int().nonnegative()
  })
  .strict();
export type SessionAdoptionBinding = z.infer<typeof sessionAdoptionBindingSchema>;

export const reassignmentFingerprintSchema = z
  .object({
    logicalSessionId: id,
    sessionLineage: lineageId,
    authorityProfile: id,
    authorityProfileVersion: id,
    policyDigest: sha256Hex,
    storageLineage: lineageId,
    predecessorWorker: opaqueRef,
    predecessorEpoch: z.number().int().nonnegative(),
    successorWorker: opaqueRef,
    successorEpoch: z.number().int().positive(),
    idempotencyKey: id
  })
  .strict();
export type ReassignmentFingerprint = z.infer<typeof reassignmentFingerprintSchema>;

export const sessionReassignedEventSchema = z
  .object({
    kind: z.literal("session_reassigned"),
    fingerprint: reassignmentFingerprintSchema,
    predecessor: sessionAdoptionBindingSchema,
    successor: sessionAdoptionBindingSchema
  })
  .strict();
export type SessionReassignedEvent = z.infer<typeof sessionReassignedEventSchema>;

export class SessionReassignmentReducer {
  private currentValue: SessionAdoptionBinding;
  private readonly history = new Map<string, SessionReassignedEvent>();

  constructor(current: SessionAdoptionBinding, replay: readonly SessionReassignedEvent[] = []) {
    this.currentValue = sessionAdoptionBindingSchema.parse(current);
    for (const event of replay) this.apply(event);
  }

  current(): SessionAdoptionBinding {
    return sessionAdoptionBindingSchema.parse(this.currentValue);
  }

  adopt(fingerprint: ReassignmentFingerprint): SessionReassignedEvent {
    const parsed = reassignmentFingerprintSchema.parse(fingerprint);
    const generationKey = `${parsed.logicalSessionId}:${parsed.predecessorWorker}:${parsed.predecessorEpoch}`;
    const existing = this.history.get(generationKey);
    if (existing) {
      if (JSON.stringify(existing.fingerprint) !== JSON.stringify(parsed))
        throw new Error("conflicting reassignment replay");
      return sessionReassignedEventSchema.parse(existing);
    }
    const predecessor = this.current();
    if (
      parsed.logicalSessionId !== predecessor.logicalSessionId ||
      parsed.sessionLineage !== predecessor.sessionLineage ||
      parsed.authorityProfile !== predecessor.authorityProfile ||
      parsed.authorityProfileVersion !== predecessor.authorityProfileVersion ||
      parsed.policyDigest !== predecessor.policyDigest ||
      parsed.storageLineage !== predecessor.storageLineage ||
      parsed.predecessorWorker !== predecessor.workerBinding ||
      parsed.predecessorEpoch !== predecessor.fenceEpoch
    )
      throw new Error("stale or mismatched reassignment predecessor");
    if (parsed.successorEpoch !== parsed.predecessorEpoch + 1)
      throw new Error("reassignment must advance exactly one fence epoch");
    const successor = sessionAdoptionBindingSchema.parse({
      ...predecessor,
      workerBinding: parsed.successorWorker,
      fenceEpoch: parsed.successorEpoch
    });
    const event = sessionReassignedEventSchema.parse({
      kind: "session_reassigned",
      fingerprint: parsed,
      predecessor,
      successor
    });
    this.apply(event);
    return event;
  }

  apply(event: SessionReassignedEvent): void {
    const parsed = sessionReassignedEventSchema.parse(event);
    const generationKey = `${parsed.fingerprint.logicalSessionId}:${parsed.fingerprint.predecessorWorker}:${parsed.fingerprint.predecessorEpoch}`;
    const existing = this.history.get(generationKey);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed))
        throw new Error("conflicting reassignment history");
      return;
    }
    if (JSON.stringify(this.currentValue) !== JSON.stringify(parsed.predecessor))
      throw new Error("non-contiguous reassignment history");
    this.history.set(generationKey, parsed);
    this.currentValue = parsed.successor;
  }
}
