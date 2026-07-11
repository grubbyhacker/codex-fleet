import { z } from "zod";

export const initializeRequestSchema = z.object({
  sessionName: z.string().min(1).optional()
});
export type InitializeRequest = z.infer<typeof initializeRequestSchema>;

export const initializeResponseSchema = z.object({
  accepted: z.literal(true),
  ownerSession: z.object({
    clientId: z.string().min(1),
    sessionName: z.string().min(1).optional()
  })
});
export type InitializeResponse = z.infer<typeof initializeResponseSchema>;

export const deliveryModeSchema = z.enum([
  "research_only",
  "patch",
  "pr_for_review",
  "full_delivery",
  "push_to_main"
]);
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;

export const riskSchema = z.enum(["low", "standard", "high"]);
export type Risk = z.infer<typeof riskSchema>;

export const modelTierSchema = z.enum(["cheap", "standard", "strong"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const modelRouteSchema = z.enum([
  "fleet-default",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol"
]);
export type ModelRoute = z.infer<typeof modelRouteSchema>;

export const mergePolicySchema = z.enum([
  "human_review",
  "agent_merge_explicit",
  "agent_merge_allowed"
]);
export type MergePolicy = z.infer<typeof mergePolicySchema>;

export const taskStateSchema = z.enum([
  "queued",
  "running",
  "exited",
  "failed_to_start",
  "cancelled",
  "timed_out",
  "stale"
]);
export type TaskState = z.infer<typeof taskStateSchema>;

export const repoTargetSchema = z.object({
  repo: z.string().min(1)
});

export const shellTargetSchema = z.object({
  shell: z.literal(true)
});

export const targetSchema = z.union([repoTargetSchema, shellTargetSchema]);
export type Target = z.infer<typeof targetSchema>;

export const targetDescriptorSchema = z.object({
  id: z.string().min(1),
  target: targetSchema,
  title: z.string().min(1),
  defaultModelTier: modelTierSchema,
  availableModelTiers: z.array(modelTierSchema).min(1),
  defaultModelRoute: modelRouteSchema,
  availableModelRoutes: z.array(modelRouteSchema).min(1),
  verifyCommands: z.array(z.string().min(1)).optional(),
  defaultBranch: z.string().min(1).optional(),
  branchProtected: z.boolean().optional(),
  mergePolicy: mergePolicySchema.optional()
});
export type TargetDescriptor = z.infer<typeof targetDescriptorSchema>;

export const listTargetsResponseSchema = z.object({
  targets: z.array(targetDescriptorSchema)
});
export type ListTargetsResponse = z.infer<typeof listTargetsResponseSchema>;

export const ownerSessionSchema = z.object({
  clientId: z.string().min(1),
  sessionName: z.string().min(1).optional()
});
export type OwnerSession = z.infer<typeof ownerSessionSchema>;

export const delegateTaskRequestSchema = z.object({
  target: targetSchema,
  deliveryMode: deliveryModeSchema,
  risk: riskSchema
    .describe(
      "Risk hint for Fleet safety policy: low for read-only/simple work, standard for normal repo work, high for security-sensitive, production, ambiguous, or high-blast-radius work."
    )
    .default("standard"),
  resumeTaskId: z.string().min(1).optional(),
  modelTier: modelTierSchema
    .describe(
      "Capability/cost tier hint. Use cheap for smoke tests, codebase exploration, read-heavy scans, simple read-only checks, and tiny mechanical work; standard for normal repo tasks and implementation slices; strong for high-risk changes, ambiguous architecture, security-sensitive work, or work likely to require deep judgment."
    )
    .optional(),
  modelRoute: modelRouteSchema
    .describe(
      "Optional concrete model route. Omit for Fleet's default route, currently gpt-5.5. Use gpt-5.6-luna for fastest/lowest-cost GPT-5.6 work, gpt-5.6-terra for balanced GPT-5.6 work, and gpt-5.6-sol only for the hardest long-horizon, ambiguous, security-sensitive, or high-consequence work. Fleet records requestedModelRoute, actualModelRoute, and workerModel for audit."
    )
    .optional(),
  prompt: z.string().min(1)
});
export type DelegateTaskRequest = z.infer<typeof delegateTaskRequestSchema>;

export const getTaskRequestSchema = z.object({
  taskId: z.string().min(1)
});
export type GetTaskRequest = z.infer<typeof getTaskRequestSchema>;

export const taskIdResponseSchema = z.object({
  taskId: z.string().min(1)
});
export type TaskIdResponse = z.infer<typeof taskIdResponseSchema>;

export const taskSnapshotSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  target: targetSchema,
  deliveryMode: deliveryModeSchema,
  risk: riskSchema,
  state: taskStateSchema,
  ownerSession: ownerSessionSchema,
  prompt: z.string().optional(),
  promptPreview: z.string().optional(),
  branch: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  shellPath: z.string().min(1).optional(),
  exitCode: z.number().int().optional(),
  finalResponse: z.string().optional(),
  finalResponsePreview: z.string().optional(),
  workerStderr: z.string().optional(),
  workerStderrPreview: z.string().optional(),
  lastActivityAt: z.string().min(1).optional(),
  requestedModel: modelTierSchema.optional(),
  actualModel: modelTierSchema.optional(),
  requestedModelRoute: modelRouteSchema.optional(),
  actualModelRoute: modelRouteSchema.optional(),
  workerModel: z.string().min(1).optional(),
  workerReasoningEffort: z.string().min(1).optional(),
  codexThreadId: z.string().min(1).optional()
});
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const getTaskResponseSchema = z.object({
  task: taskSnapshotSchema
});
export type GetTaskResponse = z.infer<typeof getTaskResponseSchema>;

export const eventSchema = z.object({
  taskId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string().min(1),
  type: z.string().min(1),
  summary: z.string(),
  payloadRef: z.string().min(1).optional()
});
export type Event = z.infer<typeof eventSchema>;

export const waitTasksRequestSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1),
  sinceEventSeq: z.number().int().nonnegative().optional(),
  maxWaitSeconds: z.number().int().positive().max(45).optional(),
  returnOnStatuses: z.array(taskStateSchema).optional()
});
export type WaitTasksRequest = z.infer<typeof waitTasksRequestSchema>;

export const waitTasksResponseSchema = z.object({
  snapshots: z.array(taskSnapshotSchema),
  events: z.array(eventSchema),
  suggestedNextWaitSeconds: z.number().int().positive()
});
export type WaitTasksResponse = z.infer<typeof waitTasksResponseSchema>;

export const listTasksRequestSchema = z.object({
  states: z.array(taskStateSchema).optional(),
  targetId: z.string().min(1).optional(),
  updatedSince: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional()
});
export type ListTasksRequest = z.infer<typeof listTasksRequestSchema>;

export const listTasksResponseSchema = z.object({
  tasks: z.array(taskSnapshotSchema)
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

export const getTaskHistoryRequestSchema = z.object({
  taskId: z.string().min(1),
  limit: z.number().int().positive().max(200).optional()
});
export type GetTaskHistoryRequest = z.infer<typeof getTaskHistoryRequestSchema>;

export const getTaskHistoryResponseSchema = z.object({
  events: z.array(eventSchema)
});
export type GetTaskHistoryResponse = z.infer<typeof getTaskHistoryResponseSchema>;

export const endTaskRequestSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1).optional()
});
export type EndTaskRequest = z.infer<typeof endTaskRequestSchema>;

export const endTaskResponseSchema = z.object({
  accepted: z.literal(true),
  taskId: z.string().min(1)
});
export type EndTaskResponse = z.infer<typeof endTaskResponseSchema>;

export const daemonMethodSchema = z.enum([
  "initialize",
  "list_targets",
  "delegate_task",
  "get_task",
  "wait_tasks",
  "list_tasks",
  "get_task_history",
  "end_task"
]);
export type DaemonMethod = z.infer<typeof daemonMethodSchema>;

export const daemonSuccessResponseSchema = z.object({
  requestId: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown()
});
export type DaemonSuccessResponse = z.infer<typeof daemonSuccessResponseSchema>;

export const daemonErrorCodeSchema = z.enum([
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "internal_error"
]);
export type DaemonErrorCode = z.infer<typeof daemonErrorCodeSchema>;

export const daemonErrorResponseSchema = z.object({
  requestId: z.string().min(1).optional(),
  ok: z.literal(false),
  error: z.object({
    code: daemonErrorCodeSchema,
    message: z.string().min(1),
    nextCall: z.string().min(1).optional()
  })
});
export type DaemonErrorResponse = z.infer<typeof daemonErrorResponseSchema>;

export const daemonResponseSchema = z.union([
  daemonSuccessResponseSchema,
  daemonErrorResponseSchema
]);
export type DaemonResponse = z.infer<typeof daemonResponseSchema>;

export const rpcEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  clientId: z.string().min(1),
  token: z.string().min(1),
  method: daemonMethodSchema,
  params: z.unknown().optional()
});
export type RpcEnvelope = z.infer<typeof rpcEnvelopeSchema>;

export const methodParamsSchemas = {
  initialize: initializeRequestSchema,
  list_targets: z.object({}).optional(),
  delegate_task: delegateTaskRequestSchema,
  get_task: getTaskRequestSchema,
  wait_tasks: waitTasksRequestSchema,
  list_tasks: listTasksRequestSchema.optional(),
  get_task_history: getTaskHistoryRequestSchema,
  end_task: endTaskRequestSchema
} satisfies Record<DaemonMethod, z.ZodType>;
