import type { DaemonMethod, ModelRoute, TaskSnapshot } from "@codex-fleet/shared";

export const deployWorkerSmokeMarker = "codex-fleet-deploy-smoke-ok";

type RpcCall = (method: DaemonMethod, params: unknown) => Promise<unknown>;

type WaitTasksResult = {
  snapshots: TaskSnapshot[];
  nextEventSeq: number;
};

export type DeployWorkerSmokeResult = {
  taskId: string;
  state: "exited";
  modelRoute: ModelRoute;
  response: string;
  released: true;
};

export async function runDeployWorkerSmoke(options: {
  call: RpcCall;
  modelRoute?: ModelRoute;
  timeoutMs?: number;
  waitSeconds?: number;
  now?: () => number;
  readyTimeoutMs?: number;
  readyRetryMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<DeployWorkerSmokeResult> {
  const modelRoute = options.modelRoute ?? "gpt-5.6-luna";
  const timeoutMs = options.timeoutMs ?? 180_000;
  const waitSeconds = options.waitSeconds ?? 30;
  const now = options.now ?? Date.now;
  await waitForDaemonReady({
    call: options.call,
    timeoutMs: options.readyTimeoutMs,
    retryMs: options.readyRetryMs,
    delay: options.delay
  });
  const deadline = now() + timeoutMs;
  const delegated = (await options.call("delegate_task", {
    target: { shell: true },
    deliveryMode: "research_only",
    risk: "low",
    modelTier: "cheap",
    modelRoute,
    prompt: `Reply with exactly: ${deployWorkerSmokeMarker}`
  })) as { taskId: string };

  let sinceEventSeq = 1;
  let terminalTask: TaskSnapshot | undefined;
  while (now() < deadline) {
    const remainingSeconds = Math.max(1, Math.ceil((deadline - now()) / 1000));
    const waited = (await options.call("wait_tasks", {
      taskIds: [delegated.taskId],
      sinceEventSeq,
      maxWaitSeconds: Math.min(waitSeconds, remainingSeconds),
      returnOnStatuses: ["exited", "failed_to_start", "cancelled", "timed_out", "stale"],
      wakeOn: "requested_status",
      snapshotDetail: "compact"
    })) as WaitTasksResult;
    sinceEventSeq = waited.nextEventSeq;
    const snapshot = waited.snapshots[0];
    if (snapshot && isTerminal(snapshot.state)) {
      terminalTask = snapshot;
      break;
    }
  }

  if (!terminalTask) {
    throw new Error(
      `Deploy worker smoke task ${delegated.taskId} did not reach a terminal state within ${timeoutMs}ms; it was not released because it may still be running`
    );
  }

  try {
    const detail = (await options.call("get_task", { taskId: delegated.taskId })) as {
      task: TaskSnapshot;
    };
    terminalTask = detail.task;
    if (terminalTask.state !== "exited") {
      throw new Error(
        `Deploy worker smoke task ${delegated.taskId} ended in ${terminalTask.state}: ${terminalTask.workerStderr ?? terminalTask.finalResponse ?? "no worker output"}`
      );
    }
    const response = terminalTask.finalResponse?.trim() ?? "";
    if (response !== deployWorkerSmokeMarker) {
      throw new Error(
        `Deploy worker smoke task ${delegated.taskId} returned ${JSON.stringify(response)} instead of ${JSON.stringify(deployWorkerSmokeMarker)}`
      );
    }
    if (terminalTask.actualModelRoute !== modelRoute) {
      throw new Error(
        `Deploy worker smoke task ${delegated.taskId} used model route ${terminalTask.actualModelRoute ?? "unknown"} instead of ${modelRoute}`
      );
    }
    return {
      taskId: delegated.taskId,
      state: "exited",
      modelRoute,
      response,
      released: true
    };
  } finally {
    await options.call("end_task", {
      taskId: delegated.taskId,
      reason: "local deployment worker smoke complete"
    });
  }
}

async function waitForDaemonReady(options: {
  call: RpcCall;
  timeoutMs?: number;
  retryMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryMs = options.retryMs ?? 100;
  const delay = options.delay ?? ((milliseconds) => Bun.sleep(milliseconds));
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await options.call("list_targets", {});
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `Installed daemon did not become RPC-ready within ${timeoutMs}ms: ${formatError(lastError)}`
  );
}

function isTerminal(state: TaskSnapshot["state"]): boolean {
  return ["exited", "failed_to_start", "cancelled", "timed_out", "stale"].includes(state);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
