import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  delegateTaskRequestSchema,
  endTaskRequestSchema,
  getTaskHistoryRequestSchema,
  getTaskRequestSchema,
  initializeRequestSchema,
  listTasksRequestSchema,
  methodParamsSchemas,
  waitTasksRequestSchema,
  type DeliveryMode,
  type DaemonMethod,
  type Event,
  type ModelTier,
  type OwnerSession,
  type RpcEnvelope,
  type TaskState,
  type TaskSnapshot,
  type TargetDescriptor
} from "@codex-fleet/shared";

import { CleanupManager } from "./cleanup/cleanup-manager.js";
import { resolveGitExecutable } from "./git.js";
import type { FleetPaths } from "./paths.js";
import { RepoRegistry } from "./registry/repo-registry.js";
import { RepoSourceManager } from "./registry/repo-source-manager.js";
import type { ClientRecord } from "./rpc/auth.js";
import { FleetError } from "./rpc/errors.js";
import { EventLog } from "./store/event-log.js";
import {
  FleetState,
  type TaskActivityPayload,
  type TaskCreatedPayload,
  type TaskStatePayload
} from "./store/state.js";
import { WorkerRunError, type WorkerBackend } from "./workers/backend.js";
import { workerBackendFromEnv } from "./workers/codex-backend.js";
import { dirtyWorktreeStopHook } from "./workers/dirty-worktree-stop-hook.js";
import { WorktreeManager } from "./worktree/worktree-manager.js";

type WorktreePostRunStatus = {
  worktreePath: string;
  branch?: string;
  baseBranch?: string;
  dirtyFiles?: number;
  stagedFiles?: number;
  unstagedFiles?: number;
  untrackedFiles?: number;
  aheadOfBase?: number;
  behindBase?: number;
  attention: string[];
  inspectionError?: string;
};

type WorkerRunInput = Parameters<WorkerBackend["run"]>[0];

export class FleetService {
  private readonly eventLog: EventLog;
  private readonly state: FleetState;
  private readonly registry: RepoRegistry;
  private readonly repoSources: RepoSourceManager;
  private readonly worktrees: WorktreeManager;
  private readonly cleanup: CleanupManager;
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
    this.repoSources = new RepoSourceManager(paths);
    this.worktrees = new WorktreeManager(paths);
    this.cleanup = new CleanupManager(paths);
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
        const tasks = this.visibleTasks(envelope.clientId, client)
          .filter((task) => !request.states || request.states.includes(task.state))
          .filter((task) => !request.targetId || targetMatches(task, request.targetId))
          .filter(
            (task) =>
              !request.updatedSince ||
              Date.parse(task.updatedAt) >= Date.parse(request.updatedSince)
          )
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
          .slice(0, request.limit);
        return { tasks: tasks.map(compactTaskSnapshot) };
      }
      case "get_task_history": {
        const request = getTaskHistoryRequestSchema.parse(params);
        this.requireTask(envelope.clientId, request.taskId, client);
        return { events: this.state.history(request.taskId, request.limit) };
      }
      case "end_task": {
        const request = endTaskRequestSchema.parse(params);
        const task = this.requireTask(envelope.clientId, request.taskId, client);
        if (!isTerminalTask(task)) {
          throw new FleetError(
            "conflict",
            `Task "${request.taskId}" is ${task.state}; wait for a terminal state before releasing resources`,
            "wait_tasks"
          );
        }
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
    let shellPath: string | undefined;

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
    }

    const modelRouting = routeModelTier(request, defaultModelTier);

    if (repoForWorktree) {
      const source =
        request.deliveryMode === "research_only" && !repoForWorktree.remoteUrl
          ? undefined
          : this.repoSources.prepare(repoForWorktree);
      if (source) {
        const resource = this.worktrees.create(repoForWorktree, taskId, source, {
          branch: request.deliveryMode !== "research_only"
        });
        branch = resource.branch;
        worktreePath = resource.worktreePath;
      } else {
        repoBaseCheckout = repoForWorktree.baseCheckout;
      }
    } else if ("shell" in request.target) {
      shellPath = allocateShellPath(this.paths, taskId);
    }

    this.append("task_created", taskId, {
      target: request.target,
      deliveryMode: request.deliveryMode,
      risk: request.risk,
      resumeTaskId: request.resumeTaskId,
      modelTier: request.modelTier,
      actualModel: modelRouting.actualModel,
      prompt: request.prompt,
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
    if (branch || worktreePath || shellPath) {
      this.append("task_resource", taskId, { branch, worktreePath, shellPath });
    }
    this.append("task_state", taskId, {
      state: "running",
      lastActivityAt: createdAt
    } satisfies TaskStatePayload);
    const workerInput = {
      taskId,
      request,
      repoBaseCheckout,
      branch,
      worktreePath,
      shellPath,
      mergePolicy: repoForWorktree?.mergePolicy
    };
    void this.runWorker({
      ...workerInput,
      stopHook: dirtyWorktreeStopHook(this.paths, workerInput)
    });

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
      prompt: request.prompt,
      promptPreview: preview(request.prompt),
      deliveryMode: request.deliveryMode,
      risk: request.risk,
      requestedModel: request.modelTier
    });
    this.append("task_state", task.id, {
      state: "running",
      lastActivityAt: now
    } satisfies TaskStatePayload);
    const repoBaseCheckout =
      "repo" in task.target && !task.worktreePath
        ? this.registry.get(task.target.repo)?.baseCheckout
        : undefined;
    const workerInput = {
      taskId: task.id,
      request,
      repoBaseCheckout,
      branch: task.branch,
      worktreePath: task.worktreePath,
      shellPath: task.shellPath,
      mergePolicy:
        "repo" in task.target ? this.registry.get(task.target.repo)?.mergePolicy : undefined,
      codexThreadId: task.codexThreadId
    };
    void this.runWorker({
      ...workerInput,
      stopHook: dirtyWorktreeStopHook(this.paths, workerInput)
    });

    return { taskId: task.id };
  }

  private async runWorker(input: WorkerRunInput): Promise<void> {
    let lastActivityEventAt = 0;
    const withActivity = (workerInput: WorkerRunInput): WorkerRunInput => ({
      ...workerInput,
      onActivity: (activity: Parameters<NonNullable<typeof workerInput.onActivity>>[0]) => {
        const nowMs = Date.now();
        if (nowMs - lastActivityEventAt < 10_000) {
          return;
        }
        lastActivityEventAt = nowMs;
        this.append("task_activity", workerInput.taskId, {
          lastActivityAt: new Date(nowMs).toISOString(),
          kind: activity.kind,
          detail: activity.detail
        } satisfies TaskActivityPayload);
      }
    });

    try {
      let currentInput = input;
      let repairAttempts = 0;
      const maxRepairAttempts = deliveryRepairMaxAttempts();

      while (true) {
        const result = await this.workerBackend.run(withActivity(currentInput));
        const worktreeStatus = this.inspectWorktreeAfterRun(currentInput);
        if (worktreeStatus) {
          this.append("worktree_status", currentInput.taskId, worktreeStatus);
        }

        const repairReasons = deliveryRepairReasons(
          currentInput.request.deliveryMode,
          worktreeStatus
        );
        if (repairReasons.length > 0 && repairAttempts < maxRepairAttempts) {
          repairAttempts += 1;
          const repairPrompt = deliveryRepairPrompt(
            currentInput.request.deliveryMode,
            currentInput.mergePolicy,
            worktreeStatus,
            repairReasons,
            repairAttempts,
            maxRepairAttempts
          );
          this.append("delivery_repair", currentInput.taskId, {
            attempt: repairAttempts,
            maxAttempts: maxRepairAttempts,
            reasons: repairReasons,
            prompt: repairPrompt,
            promptPreview: preview(repairPrompt)
          });
          this.append("task_resumed", currentInput.taskId, {
            prompt: repairPrompt,
            promptPreview: preview(repairPrompt),
            deliveryMode: currentInput.request.deliveryMode,
            risk: currentInput.request.risk,
            requestedModel: currentInput.request.modelTier
          });
          this.append("task_state", currentInput.taskId, {
            state: "running",
            codexThreadId: result.codexThreadId,
            lastActivityAt: new Date().toISOString()
          } satisfies TaskStatePayload);
          currentInput = {
            ...currentInput,
            request: {
              ...currentInput.request,
              prompt: repairPrompt
            },
            codexThreadId: result.codexThreadId ?? currentInput.codexThreadId
          };
          continue;
        }

        const finalAttention = [...(worktreeStatus?.attention ?? [])];
        if (repairReasons.length > 0 && maxRepairAttempts > 0) {
          const exhausted = `Fleet post-check: delivery repair attempts exhausted after ${repairAttempts} attempt(s); worktree preserved for orchestrator follow-up.`;
          finalAttention.push(exhausted);
          this.append("delivery_repair_exhausted", currentInput.taskId, {
            attempts: repairAttempts,
            maxAttempts: maxRepairAttempts,
            reasons: repairReasons,
            attention: exhausted
          });
        }

        const finalResponse = appendFleetPostCheck(result.finalResponse, finalAttention);
        this.append("task_state", currentInput.taskId, {
          state: "exited",
          exitCode: result.exitCode,
          finalResponse,
          finalResponsePreview: preview(finalResponse, 500),
          workerStderr: result.workerStderr,
          workerStderrPreview: result.workerStderrPreview,
          codexThreadId: result.codexThreadId,
          lastActivityAt: new Date().toISOString()
        } satisfies TaskStatePayload);
        return;
      }
    } catch (error) {
      const workerStderr = error instanceof WorkerRunError ? error.workerStderr : undefined;
      this.append("task_state", input.taskId, {
        state: error instanceof WorkerRunError ? error.terminalState : "failed_to_start",
        finalResponse: error instanceof Error ? error.message : String(error),
        finalResponsePreview:
          error instanceof Error ? preview(error.message) : preview(String(error)),
        workerStderr,
        workerStderrPreview:
          error instanceof WorkerRunError ? error.workerStderrPreview : undefined,
        lastActivityAt: new Date().toISOString()
      } satisfies TaskStatePayload);
    }
  }

  private inspectWorktreeAfterRun(
    input: Parameters<WorkerBackend["run"]>[0]
  ): WorktreePostRunStatus | undefined {
    if (!input.worktreePath || !("repo" in input.request.target)) {
      return undefined;
    }

    const repo = this.registry.get(input.request.target.repo);
    const baseRef = repo ? this.repoSources.prepare(repo).startPoint : undefined;
    const baseBranch = displayBaseRef(baseRef);
    const status: WorktreePostRunStatus = {
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseBranch,
      attention: []
    };

    if (!existsSync(input.worktreePath)) {
      return {
        ...status,
        inspectionError: "worktree_missing",
        attention: [`Fleet post-check: worktree is missing at ${input.worktreePath}.`]
      };
    }

    try {
      const lines = gitOutput(input.worktreePath, ["status", "--porcelain"])
        .split("\n")
        .filter(Boolean);
      const stagedFiles = lines.filter((line) => line[0] !== " " && line[0] !== "?").length;
      const unstagedFiles = lines.filter((line) => line[1] !== " " && line[1] !== "?").length;
      const untrackedFiles = lines.filter((line) => line.startsWith("??")).length;
      Object.assign(status, {
        dirtyFiles: lines.length,
        stagedFiles,
        unstagedFiles,
        untrackedFiles
      });

      if (baseRef) {
        const [behind, ahead] = gitOutput(input.worktreePath, [
          "rev-list",
          "--left-right",
          "--count",
          `${baseRef}...HEAD`
        ])
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10));
        status.behindBase = Number.isFinite(behind) ? behind : undefined;
        status.aheadOfBase = Number.isFinite(ahead) ? ahead : undefined;
      }

      status.attention = worktreeAttention(input.request.deliveryMode, status);
      return status;
    } catch (error) {
      return {
        ...status,
        inspectionError: error instanceof Error ? error.message : String(error),
        attention: ["Fleet post-check: could not inspect the task worktree git status."]
      };
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
      if (events.length === 0) {
        events = snapshots
          .filter((task) => task.state === "running" || task.state === "stale")
          .map((task) => this.append("task_observation", task.id, quietObservation(task)));
      }
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

function compactTaskSnapshot(task: TaskSnapshot): TaskSnapshot {
  const {
    finalResponse,
    finalResponsePreview,
    prompt,
    workerStderr,
    workerStderrPreview,
    ...compact
  } = task;
  void finalResponse;
  void finalResponsePreview;
  void prompt;
  void workerStderr;
  void workerStderrPreview;
  return compact;
}

function quietObservation(task: TaskSnapshot): {
  state: TaskState;
  lastActivityAt?: string;
  quietForSeconds?: number;
  checkedAt: string;
  message: string;
} {
  const checkedAt = new Date().toISOString();
  const lastActivityAt = task.lastActivityAt ?? task.updatedAt;
  const lastActivityMs = Date.parse(lastActivityAt);
  const checkedMs = Date.parse(checkedAt);
  const quietForSeconds =
    Number.isFinite(lastActivityMs) && Number.isFinite(checkedMs)
      ? Math.max(0, Math.floor((checkedMs - lastActivityMs) / 1000))
      : undefined;
  const quietPhrase =
    quietForSeconds === undefined
      ? "with no new worker events in this wait window"
      : `with no new worker events for ${quietForSeconds} second(s)`;

  return {
    state: task.state,
    lastActivityAt,
    quietForSeconds,
    checkedAt,
    message: `Fleet observed task ${task.state} ${quietPhrase}; last worker activity remains ${lastActivityAt}.`
  };
}

function targetMatches(task: TaskSnapshot, targetId: string): boolean {
  return "repo" in task.target ? task.target.repo === targetId : targetId === "shell";
}

function allocateShellPath(paths: FleetPaths, taskId: string): string {
  const shellPath = join(paths.shellDir, taskId.slice(0, 8));
  mkdirSync(shellPath, { mode: 0o700, recursive: true });
  return shellPath;
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync(resolveGitExecutable(), args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function displayBaseRef(baseRef: string | undefined): string | undefined {
  return baseRef?.replace(/^refs\/remotes\//, "");
}

function worktreeAttention(deliveryMode: DeliveryMode, status: WorktreePostRunStatus): string[] {
  if (
    deliveryMode !== "pr_for_review" &&
    deliveryMode !== "full_delivery" &&
    deliveryMode !== "push_to_main"
  ) {
    return [];
  }

  const attention: string[] = [];
  if ((status.dirtyFiles ?? 0) > 0) {
    attention.push(
      `Fleet post-check: worktree has ${status.dirtyFiles} uncommitted file(s) after ${deliveryMode}.`
    );
  }
  if (status.aheadOfBase === 0) {
    attention.push(
      `Fleet post-check: branch has no commits ahead of ${status.baseBranch ?? "the base branch"}.`
    );
  }
  return attention;
}

function deliveryRepairReasons(
  deliveryMode: DeliveryMode,
  status: WorktreePostRunStatus | undefined
): string[] {
  if (!status || !deliveryRepairModes.has(deliveryMode)) {
    return [];
  }

  const reasons: string[] = [];
  if ((status.dirtyFiles ?? 0) > 0) {
    reasons.push(`worktree has ${status.dirtyFiles} uncommitted file(s)`);
  }
  if (deliveryMode === "pr_for_review" && status.aheadOfBase === 0) {
    reasons.push(`branch has no commits ahead of ${status.baseBranch ?? "the base branch"}`);
  }
  return reasons;
}

const deliveryRepairModes = new Set<DeliveryMode>([
  "pr_for_review",
  "full_delivery",
  "push_to_main"
]);

function deliveryRepairMaxAttempts(): number {
  const parsed = Number.parseInt(process.env.CODEX_FLEET_DELIVERY_REPAIR_MAX_ATTEMPTS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

function deliveryRepairPrompt(
  deliveryMode: DeliveryMode,
  mergePolicy: WorkerRunInput["mergePolicy"],
  status: WorktreePostRunStatus | undefined,
  reasons: string[],
  attempt: number,
  maxAttempts: number
): string {
  const statusLines = status
    ? [
        `- Worktree: ${status.worktreePath}`,
        status.branch ? `- Branch: ${status.branch}` : undefined,
        status.baseBranch ? `- Base: ${status.baseBranch}` : undefined,
        `- Dirty files: ${status.dirtyFiles ?? "unknown"}`,
        `- Staged files: ${status.stagedFiles ?? "unknown"}`,
        `- Unstaged files: ${status.unstagedFiles ?? "unknown"}`,
        `- Untracked files: ${status.untrackedFiles ?? "unknown"}`,
        status.aheadOfBase !== undefined
          ? `- Commits ahead of base: ${status.aheadOfBase}`
          : undefined,
        status.behindBase !== undefined ? `- Commits behind base: ${status.behindBase}` : undefined
      ].filter((line): line is string => Boolean(line))
    : ["- Worktree status unavailable"];

  return [
    "Resume and finish the Fleet delivery contract. Your previous response did not satisfy Fleet postconditions.",
    "",
    `Repair attempt ${attempt}/${maxAttempts}.`,
    `Delivery mode: ${deliveryMode}.`,
    `Postcondition failure: ${reasons.join("; ")}.`,
    "",
    "Current Fleet worktree status:",
    ...statusLines,
    "",
    "Do not discard intended changes. Inspect the worktree, preserve useful work, and reconcile it according to the delivery contract.",
    mergePolicyRepairInstruction(mergePolicy),
    deliveryModeRepairInstruction(deliveryMode, mergePolicy),
    "If you are blocked, stop only after reporting `git status --short`, the exact blocker, and what state is preserved."
  ].join("\n");
}

function mergePolicyRepairInstruction(mergePolicy: WorkerRunInput["mergePolicy"]): string {
  switch (mergePolicy) {
    case "human_review":
      return "Repo merge policy: human_review. Do not merge your own PR or push directly to the default branch. Open or update a ready PR, take one CI/check snapshot, report the PR URL and check results, then stop.";
    case "agent_merge_explicit":
      return "Repo merge policy: agent_merge_explicit. Do not merge unless the current prompt explicitly instructs you to merge this PR. Otherwise stop after a ready PR and one CI/check snapshot.";
    case "agent_merge_allowed":
      return "Repo merge policy: agent_merge_allowed. You may merge when the delivery mode, prompt, repository rules, and checks all allow it.";
    default:
      return "Repo merge policy: unspecified. Do not assume merge authority; prefer stopping after a ready PR and one CI/check snapshot unless the prompt explicitly says to merge.";
  }
}

function deliveryModeRepairInstruction(
  deliveryMode: DeliveryMode,
  mergePolicy: WorkerRunInput["mergePolicy"]
): string {
  switch (deliveryMode) {
    case "pr_for_review":
      return "For pr_for_review, stage and commit intended changes, push the branch, open or report the ready PR URL, and stop with a clean worktree.";
    case "full_delivery":
      if (mergePolicy === "human_review") {
        return "For full_delivery under human_review, stage and commit intended changes, push the branch, open or update a ready PR, take one CI/check snapshot, report the PR URL and checks, and stop before merge.";
      }
      if (mergePolicy === "agent_merge_explicit") {
        return "For full_delivery under agent_merge_explicit, stage and commit intended changes, push/open/update the PR, and merge only if the current task prompt explicitly instructs this PR to be merged.";
      }
      return "For full_delivery, stage and commit intended changes, push/open/merge as required by the repo and prompt, verify remote state, and stop with a clean worktree.";
    case "push_to_main":
      if (mergePolicy === "human_review") {
        return "For push_to_main under human_review, do not push directly to the default branch; report that this repo requires a PR for human review.";
      }
      return "For push_to_main, stage and commit intended changes, push the requested default-branch change, and stop with a clean worktree.";
    case "patch":
      return "For patch, report the preserved diff and blocker.";
    case "research_only":
      return "For research_only, report the blocker without mutating the repository further.";
  }
}

function appendFleetPostCheck(response: string, attention: string[] | undefined): string {
  if (!attention?.length) {
    return response;
  }
  const note = attention.join("\n");
  return response.length > 0 ? `${response}\n\n${note}` : note;
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

function isTerminalTask(task: TaskSnapshot): boolean {
  return ["exited", "failed_to_start", "cancelled", "timed_out"].includes(task.state);
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
