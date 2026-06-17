import { z } from "zod";

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

export const ownerSessionSchema = z.object({
  clientId: z.string().min(1),
  sessionName: z.string().min(1).optional()
});
export type OwnerSession = z.infer<typeof ownerSessionSchema>;

export const delegateTaskRequestSchema = z.object({
  target: targetSchema,
  deliveryMode: deliveryModeSchema,
  risk: riskSchema.default("standard"),
  resumeTaskId: z.string().min(1).optional(),
  modelTier: modelTierSchema.optional(),
  prompt: z.string().min(1)
});
export type DelegateTaskRequest = z.infer<typeof delegateTaskRequestSchema>;

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
  branch: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  exitCode: z.number().int().optional(),
  finalResponsePreview: z.string().optional(),
  lastActivityAt: z.string().min(1).optional(),
  requestedModel: modelTierSchema.optional(),
  actualModel: modelTierSchema.optional()
});
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

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

export const rpcEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  clientId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional()
});
export type RpcEnvelope = z.infer<typeof rpcEnvelopeSchema>;
