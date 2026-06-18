import { randomUUID } from "node:crypto";

import {
  delegateTaskRequestSchema,
  endTaskRequestSchema,
  getTaskHistoryRequestSchema,
  getTaskRequestSchema,
  initializeRequestSchema,
  listTasksRequestSchema,
  methodParamsSchemas,
  waitTasksRequestSchema,
  type DaemonMethod,
  type Event,
  type ModelTier,
  type OwnerSession,
  type RpcEnvelope,
  type TaskSnapshot,
  type TargetDescriptor
} from "@codex-fleet/shared";

import { CleanupManager } from "./cleanup/cleanup-manager.js";
import type { FleetPaths } from "./paths.js";
import { RepoRegistry } from "./registry/repo-registry.js";
import type { ClientRecord } from "./rpc/auth.js";
import { FleetError } from "./rpc/errors.js";
import { EventLog } from "./store/event-log.js";
import { FleetState, type TaskCreatedPayload, type TaskStatePayload } from "./store/state.js";
import type { WorkerBackend } from "./workers/backend.js";
import { workerBackendFromEnv } from "./workers/codex-backend.js";
import { WorktreeManager } from "./worktree/worktree-manager.js";

export class FleetService {
  private readonly eventLog: EventLog;
  private readonly state: FleetState;
  private readonly registry: RepoRegistry;
  private readonly worktrees: WorktreeManager;
  private readonly cleanup = new CleanupManager();
  private nextSeq: number;
  private readonly sessions = new Map<string, OwnerSession>();

  constructor(
    readonly paths: FleetPaths,
    private readonly workerBackend: WorkerBackend = workerBackendFromEnv(),
    private readonly staleAfterMs = 5 * 60 * 1000
  ) {
    this.eventLog = new EventLog(paths.eventsPath);
    const events = this.eventLog.readAll();
    this.state = FleetState.replay(events);
    this.registry = RepoRegistry.load(paths);
    this.worktrees = new WorktreeManager(paths);
    this.nextSeq = events.reduce((max, event) => Math.max(max, event.seq), -1) + 1;
  }

  async handle(
    method: DaemonMethod,
    envelope: RpcEnvelope,
    client?: ClientRecord
  ): Promise<unknown> {
    this.refreshStaleTasks();
    const params = methodParamsSchemas[method].parse(envelope.params ?? {});

    switch (method) {
      case "initialize": {
        const request = initializeRequestSchema.parse(params);
        const ownerSession = this.ownerFor(envelope.clientId, request.sessionName);
        this.sessions.set(envelope.clientId, ownerSession);
        return { accepted: true, ownerSession };
      }
      case "list_targets":
        return { targets: this.listTargets() };
      case "delegate_task":
        return await this.delegateTask(envelope.clientId, delegateTaskRequestSchema.parse(params));
      case "get_task":
        return {
          task: this.requireTask(
            envelope.clientId,
            getTaskRequestSchema.parse(params).taskId,
            client
          )
        };
      case "wait_tasks":
        return this.waitTasks(envelope.clientId, waitTasksRequestSchema.parse(params), client);
      case "list_tasks": {
        const request = listTasksRequestSchema.parse(params);
        const tasks = this.visibleTasks(envelope.clientId, client).filter(
          (task) => !request.states || request.states.includes(task.state)
        );
        return { tasks };
      }
      case "get_task_history": {
        const request = getTaskHistoryRequestSchema.parse(params);
        this.requireTask(envelope.clientId, request.taskId, client);
        return { events: this.state.history(request.taskId, request.limit) };
      }
      case "end_task": {
        const request = endTaskRequestSchema.parse(params);
        const task = this.requireTask(envelope.clientId, request.taskId, client);
        const repo = "repo" in task.target ? this.registry.get(task.target.repo) : undefined;
        const cleanup = this.cleanup.releaseWorktree(task, repo);
        return { accepted: true, taskId: request.taskId, cleanup };
      }
    }
  }

  private listTargets(): TargetDescriptor[] {
    const shellTarget: TargetDescriptor = {
      id: "shell",
      target: { shell: true },
      title: "Host shell",
      defaultModelTier: "standard",
      availableModelTiers: ["cheap", "standard", "strong"]
    };
    return [shellTarget].concat(this.registry.listDescriptors());
  }

  private async delegateTask(
    clientId: string,
    request: ReturnType<typeof delegateTaskRequestSchema.parse>
  ): Promise<{ taskId: string }> {
    if (request.resumeTaskId) {
      return this.resumeTask(clientId, request);
    }

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const ownerSession = this.ownerFor(clientId);
    let defaultModelTier: ModelTier = "standard";
    let repoForWorktree: ReturnType<RepoRegistry["get"]>;
    let repoBaseCheckout: string | undefined;
    let branch: string | undefined;
    let worktreePath: string | undefined;

    if ("repo" in request.target) {
      const repo = this.registry.get(request.target.repo);
      if (!repo) {
        throw new FleetError(
          "not_found",
          `Unknown repo target "${request.target.repo}"`,
          "list_targets"
        );
      }
      defaultModelTier = repo.defaultModelTier;
      repoForWorktree = repo;
      repoBaseCheckout = repo.baseCheckout;
    }

    const modelRouting = routeModelTier(request, defaultModelTier);

    if (repoForWorktree && request.deliveryMode !== "research_only") {
      const resource = this.worktrees.create(repoForWorktree, taskId);
      branch = resource.branch;
      worktreePath = resource.worktreePath;
    }

    this.append("task_created", taskId, {
      target: request.target,
      deliveryMode: request.deliveryMode,
      risk: request.risk,
      resumeTaskId: request.resumeTaskId,
      modelTier: request.modelTier,
      actualModel: modelRouting.actualModel,
      promptPreview: preview(request.prompt),
      ownerSession,
      createdAt
    } satisfies TaskCreatedPayload);
    if (
      modelRouting.reason === "safety_upgrade" ||
      modelRouting.reason === "requested_unavailable_fallback"
    ) {
      this.append("model_routing", taskId, modelRouting);
    }
    if (branch || worktreePath) {
      this.append("task_resource", taskId, { branch, worktreePath });
    }
    this.append("task_state", taskId, {
      state: "running",
      lastActivityAt: createdAt
    } satisfies TaskStatePayload);
    void this.runWorker({ taskId, request, repoBaseCheckout, branch, worktreePath });

    return { taskId };
  }

  private resumeTask(
    clientId: string,
    request: ReturnType<typeof delegateTaskRequestSchema.parse>
  ): { taskId: string } {
    const task = this.requireTask(clientId, request.resumeTaskId ?? "");
    if (task.state === "running" || task.state === "stale") {
      throw new FleetError("conflict", `Task "${task.id}" is already running`, "get_task");
    }
    if (JSON.stringify(task.target) !== JSON.stringify(request.target)) {
      throw new FleetError("conflict", `resumeTaskId target must match task "${task.id}"`);
    }

    const now = new Date().toISOString();
    this.append("task_resumed", task.id, {
      promptPreview: preview(request.prompt),
      deliveryMode: request.deliveryMode,
      risk: request.risk,
      requestedModel: request.modelTier
    });
    this.append("task_state", task.id, {
      state: "running",
      lastActivityAt: now
    } satisfies TaskStatePayload);
    void this.runWorker({
      taskId: task.id,
      request,
      branch: task.branch,
      worktreePath: task.worktreePath,
      codexThreadId: task.codexThreadId
    });

    return { taskId: task.id };
  }

  private async runWorker(input: Parameters<WorkerBackend["run"]>[0]): Promise<void> {
    try {
      const result = await this.workerBackend.run(input);
      this.append("task_state", input.taskId, {
        state: "exited",
        exitCode: result.exitCode,
        finalResponse: result.finalResponse,
        finalResponsePreview: result.finalResponsePreview,
        codexThreadId: result.codexThreadId,
        lastActivityAt: new Date().toISOString()
      } satisfies TaskStatePayload);
    } catch (error) {
      this.append("task_state", input.taskId, {
        state: "failed_to_start",
        finalResponsePreview:
          error instanceof Error ? preview(error.message) : preview(String(error)),
        lastActivityAt: new Date().toISOString()
      } satisfies TaskStatePayload);
    }
  }

  private async waitTasks(
    clientId: string,
    request: ReturnType<typeof waitTasksRequestSchema.parse>,
    client?: ClientRecord
  ) {
    let snapshots = request.taskIds.map((taskId) => this.requireTask(clientId, taskId, client));
    let events = this.state.eventsSince(request.sinceEventSeq, request.taskIds);
    if (events.length === 0 && !matchesReturnStatus(snapshots, request.returnOnStatuses)) {
      await sleep(Math.min(request.maxWaitSeconds ?? 5, 45) * 1000);
      this.refreshStaleTasks();
      snapshots = request.taskIds.map((taskId) => this.requireTask(clientId, taskId, client));
      events = this.state.eventsSince(request.sinceEventSeq, request.taskIds);
    }
    return {
      snapshots,
      events,
      suggestedNextWaitSeconds: Math.min(request.maxWaitSeconds ?? 5, 45)
    };
  }

  private requireTask(clientId: string, taskId: string, client?: ClientRecord) {
    const task = this.state.getTask(taskId);
    if (!task) {
      throw new FleetError("not_found", `Unknown task "${taskId}"`, "list_tasks");
    }
    if (hasFleetReadAccess(client)) {
      return task;
    }
    const ownerSession = this.ownerFor(clientId);
    if (task.ownerSession.clientId !== ownerSession.clientId) {
      throw new FleetError("not_found", `Unknown task "${taskId}"`, "list_tasks");
    }
    return task;
  }

  private visibleTasks(clientId: string, client?: ClientRecord) {
    return hasFleetReadAccess(client)
      ? this.state.listAllTasks()
      : this.state.listTasks(this.ownerFor(clientId));
  }

  private ownerFor(
    clientId: string,
    sessionName = this.sessions.get(clientId)?.sessionName
  ): OwnerSession {
    return sessionName ? { clientId, sessionName } : { clientId };
  }

  private append(type: string, taskId: string, payload: unknown): Event {
    const event: Event = {
      taskId,
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      type,
      summary: JSON.stringify(payload)
    };
    this.nextSeq += 1;
    this.eventLog.append(event);
    this.state.apply(event);
    return event;
  }

  private refreshStaleTasks(): void {
    const now = Date.now();
    for (const task of this.state.listAllTasks()) {
      if (task.state !== "running") {
        continue;
      }
      const lastActivity = Date.parse(task.lastActivityAt ?? task.updatedAt);
      if (Number.isFinite(lastActivity) && now - lastActivity > this.staleAfterMs) {
        this.append("task_state", task.id, {
          state: "stale",
          lastActivityAt: task.lastActivityAt
        } satisfies TaskStatePayload);
      }
    }
  }
}

function preview(value: string, maxLength = 240): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function routeModelTier(
  request: ReturnType<typeof delegateTaskRequestSchema.parse>,
  defaultModelTier: ModelTier
): {
  requestedModel?: ModelTier;
  defaultModelTier: ModelTier;
  actualModel: ModelTier;
  availableModelTiers: ModelTier[];
  reason:
    | "requested_available"
    | "default_selected"
    | "safety_upgrade"
    | "requested_unavailable_fallback";
} {
  const availableModelTiers = availableModelTiersFromEnv();
  const minimumTier =
    request.risk === "high" ||
    request.deliveryMode === "full_delivery" ||
    request.deliveryMode === "push_to_main"
      ? "strong"
      : "cheap";
  const requestedModel = request.modelTier;
  const preferredTier = requestedModel ?? defaultModelTier;
  const requiredTier = strongerTier(preferredTier, minimumTier);
  const actualModel = firstAvailableAtLeast(availableModelTiers, requiredTier);
  if (!actualModel) {
    throw new FleetError(
      "conflict",
      `No available model tier satisfies minimum "${requiredTier}"`,
      "list_targets"
    );
  }

  return {
    requestedModel,
    defaultModelTier,
    actualModel,
    availableModelTiers,
    reason: modelRoutingReason(requestedModel, preferredTier, requiredTier, actualModel)
  };
}

function modelRoutingReason(
  requestedModel: ModelTier | undefined,
  preferredTier: ModelTier,
  requiredTier: ModelTier,
  actualModel: ModelTier
):
  | "requested_available"
  | "default_selected"
  | "safety_upgrade"
  | "requested_unavailable_fallback" {
  if (!requestedModel) {
    return actualModel === preferredTier ? "default_selected" : "requested_unavailable_fallback";
  }
  if (tierRank(requiredTier) > tierRank(preferredTier)) {
    return "safety_upgrade";
  }
  return actualModel === requestedModel ? "requested_available" : "requested_unavailable_fallback";
}

function availableModelTiersFromEnv(): ModelTier[] {
  const raw = process.env.CODEX_FLEET_AVAILABLE_MODEL_TIERS;
  const parsed = raw
    ?.split(",")
    .map((tier) => tier.trim())
    .filter((tier): tier is ModelTier => ["cheap", "standard", "strong"].includes(tier));
  return parsed && parsed.length > 0 ? parsed : ["cheap", "standard", "strong"];
}

function firstAvailableAtLeast(
  availableModelTiers: ModelTier[],
  minimumTier: ModelTier
): ModelTier | undefined {
  return (["cheap", "standard", "strong"] as const)
    .filter((tier) => tierRank(tier) >= tierRank(minimumTier))
    .find((tier) => availableModelTiers.includes(tier));
}

function strongerTier(left: ModelTier, right: ModelTier): ModelTier {
  return tierRank(left) >= tierRank(right) ? left : right;
}

function tierRank(tier: ModelTier): number {
  return { cheap: 0, standard: 1, strong: 2 }[tier];
}

function hasFleetReadAccess(client?: ClientRecord): boolean {
  return client?.role === "cli" || client?.role === "dashboard";
}

function matchesReturnStatus(
  snapshots: TaskSnapshot[],
  statuses?: ReturnType<typeof waitTasksRequestSchema.parse>["returnOnStatuses"]
): boolean {
  return Boolean(
    statuses?.some((status) => snapshots.some((snapshot) => snapshot.state === status))
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
