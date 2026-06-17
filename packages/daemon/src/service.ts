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
  type OwnerSession,
  type RpcEnvelope,
  type TargetDescriptor
} from "@codex-fleet/shared";

import type { FleetPaths } from "./paths.js";
import { RepoRegistry } from "./registry/repo-registry.js";
import { FleetError } from "./rpc/errors.js";
import { EventLog } from "./store/event-log.js";
import { FleetState, type TaskCreatedPayload, type TaskStatePayload } from "./store/state.js";
import { FakeWorkerBackend, type WorkerBackend } from "./workers/backend.js";
import { WorktreeManager } from "./worktree/worktree-manager.js";

export class FleetService {
  private readonly eventLog: EventLog;
  private readonly state: FleetState;
  private readonly registry: RepoRegistry;
  private readonly worktrees: WorktreeManager;
  private nextSeq: number;
  private readonly sessions = new Map<string, OwnerSession>();

  constructor(
    readonly paths: FleetPaths,
    private readonly workerBackend: WorkerBackend = new FakeWorkerBackend()
  ) {
    this.eventLog = new EventLog(paths.eventsPath);
    const events = this.eventLog.readAll();
    this.state = FleetState.replay(events);
    this.registry = RepoRegistry.load(paths);
    this.worktrees = new WorktreeManager(paths);
    this.nextSeq = events.reduce((max, event) => Math.max(max, event.seq), -1) + 1;
  }

  handle(method: DaemonMethod, envelope: RpcEnvelope): unknown {
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
        return this.delegateTask(envelope.clientId, delegateTaskRequestSchema.parse(params));
      case "get_task":
        return {
          task: this.requireTask(envelope.clientId, getTaskRequestSchema.parse(params).taskId)
        };
      case "wait_tasks":
        return this.waitTasks(envelope.clientId, waitTasksRequestSchema.parse(params));
      case "list_tasks": {
        const request = listTasksRequestSchema.parse(params);
        const tasks = this.state
          .listTasks(this.ownerFor(envelope.clientId))
          .filter((task) => !request.states || request.states.includes(task.state));
        return { tasks };
      }
      case "get_task_history": {
        const request = getTaskHistoryRequestSchema.parse(params);
        this.requireTask(envelope.clientId, request.taskId);
        return { events: this.state.history(request.taskId, request.limit) };
      }
      case "end_task": {
        const request = endTaskRequestSchema.parse(params);
        this.requireTask(envelope.clientId, request.taskId);
        return { accepted: true, taskId: request.taskId };
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

  private delegateTask(
    clientId: string,
    request: ReturnType<typeof delegateTaskRequestSchema.parse>
  ): { taskId: string } {
    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const ownerSession = this.ownerFor(clientId);
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

      if (request.deliveryMode !== "research_only") {
        const resource = this.worktrees.create(repo, taskId);
        branch = resource.branch;
        worktreePath = resource.worktreePath;
      }
    }

    this.append("task_created", taskId, {
      target: request.target,
      deliveryMode: request.deliveryMode,
      risk: request.risk,
      resumeTaskId: request.resumeTaskId,
      modelTier: request.modelTier,
      promptPreview: preview(request.prompt),
      ownerSession,
      createdAt
    } satisfies TaskCreatedPayload);
    if (branch || worktreePath) {
      this.append("task_resource", taskId, { branch, worktreePath });
    }
    this.append("task_state", taskId, {
      state: "running",
      lastActivityAt: createdAt
    } satisfies TaskStatePayload);
    const result = this.workerBackend.run({ taskId, request, branch, worktreePath });
    this.append("task_state", taskId, {
      state: "exited",
      exitCode: result.exitCode,
      finalResponsePreview: result.finalResponsePreview,
      lastActivityAt: new Date().toISOString()
    } satisfies TaskStatePayload);

    return { taskId };
  }

  private waitTasks(clientId: string, request: ReturnType<typeof waitTasksRequestSchema.parse>) {
    const snapshots = request.taskIds.map((taskId) => this.requireTask(clientId, taskId));
    const events = this.state.eventsSince(request.sinceEventSeq, request.taskIds);
    return {
      snapshots,
      events,
      suggestedNextWaitSeconds: Math.min(request.maxWaitSeconds ?? 5, 45)
    };
  }

  private requireTask(clientId: string, taskId: string) {
    const task = this.state.getTask(taskId);
    if (!task) {
      throw new FleetError("not_found", `Unknown task "${taskId}"`, "list_tasks");
    }
    const ownerSession = this.ownerFor(clientId);
    if (task.ownerSession.clientId !== ownerSession.clientId) {
      throw new FleetError("not_found", `Unknown task "${taskId}"`, "list_tasks");
    }
    return task;
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
}

function preview(value: string, maxLength = 240): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
