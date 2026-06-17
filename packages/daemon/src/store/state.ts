import {
  type DelegateTaskRequest,
  type Event,
  type OwnerSession,
  type TaskSnapshot,
  taskSnapshotSchema
} from "@codex-fleet/shared";

export type TaskCreatedPayload = Omit<DelegateTaskRequest, "prompt"> & {
  ownerSession: OwnerSession;
  createdAt: string;
  promptPreview: string;
  actualModel: TaskSnapshot["actualModel"];
};

export type TaskStatePayload = {
  state: TaskSnapshot["state"];
  exitCode?: number;
  finalResponsePreview?: string;
  lastActivityAt?: string;
};

export type TaskResourcePayload = {
  branch?: string;
  worktreePath?: string;
};

export class FleetState {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly events: Event[] = [];

  static replay(events: Event[]): FleetState {
    const state = new FleetState();
    for (const event of events) {
      state.apply(event);
    }
    return state;
  }

  apply(event: Event): void {
    this.events.push(event);

    if (event.type === "task_created") {
      const payload = parsePayload<TaskCreatedPayload>(event);
      this.tasks.set(
        event.taskId,
        taskSnapshotSchema.parse({
          id: event.taskId,
          createdAt: payload.createdAt,
          updatedAt: event.ts,
          target: payload.target,
          deliveryMode: payload.deliveryMode,
          risk: payload.risk,
          state: "queued",
          ownerSession: payload.ownerSession,
          requestedModel: payload.modelTier,
          actualModel: payload.actualModel
        })
      );
      return;
    }

    const existing = this.tasks.get(event.taskId);
    if (!existing) {
      return;
    }

    if (event.type === "task_state") {
      const payload = parsePayload<TaskStatePayload>(event);
      this.tasks.set(event.taskId, {
        ...existing,
        updatedAt: event.ts,
        state: payload.state,
        exitCode: payload.exitCode,
        finalResponsePreview: payload.finalResponsePreview,
        lastActivityAt: payload.lastActivityAt ?? event.ts
      });
      return;
    }

    if (event.type === "task_resource") {
      const payload = parsePayload<TaskResourcePayload>(event);
      this.tasks.set(event.taskId, {
        ...existing,
        updatedAt: event.ts,
        branch: payload.branch,
        worktreePath: payload.worktreePath
      });
    }
  }

  getTask(taskId: string): TaskSnapshot | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(ownerSession: OwnerSession): TaskSnapshot[] {
    return [...this.tasks.values()].filter((task) => sameOwner(task.ownerSession, ownerSession));
  }

  listAllTasks(): TaskSnapshot[] {
    return [...this.tasks.values()];
  }

  history(taskId: string, limit = 50): Event[] {
    return this.events.filter((event) => event.taskId === taskId).slice(-limit);
  }

  eventsSince(seq?: number, taskIds?: string[]): Event[] {
    const idSet = taskIds ? new Set(taskIds) : undefined;
    return this.events.filter((event) => {
      if (seq !== undefined && event.seq <= seq) {
        return false;
      }
      return !idSet || idSet.has(event.taskId);
    });
  }
}

function parsePayload<T>(event: Event): T {
  return JSON.parse(event.summary) as T;
}

function sameOwner(left: OwnerSession, right: OwnerSession): boolean {
  return left.clientId === right.clientId && left.sessionName === right.sessionName;
}
