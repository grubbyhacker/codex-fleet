import type { DelegateTaskRequest, MergePolicy } from "@codex-fleet/shared";

export type WorkerActivityTelemetry = {
  eventType?: string;
  toolName?: string;
  callId?: string;
  commandPreview?: string;
  durationMs?: number;
  exitCode?: number;
  important?: boolean;
};

export type WorkerActivity = {
  kind: "heartbeat" | "codex_event";
  detail?: string;
  telemetry?: WorkerActivityTelemetry;
};

export type WorkerInput = {
  taskId: string;
  request: DelegateTaskRequest;
  repoBaseCheckout?: string;
  worktreePath?: string;
  shellPath?: string;
  branch?: string;
  mergePolicy?: MergePolicy;
  codexThreadId?: string;
  stopHook?: WorkerStopHook;
  onActivity?: (activity: WorkerActivity) => void;
};

export type WorkerStopHook = {
  command: string;
  timeoutSeconds: number;
  statusMessage?: string;
};

export type WorkerResult = {
  exitCode: number;
  finalResponse: string;
  finalResponsePreview: string;
  codexThreadId?: string;
  workerStderr?: string;
  workerStderrPreview?: string;
};

export interface WorkerBackend {
  run(input: WorkerInput): Promise<WorkerResult> | WorkerResult;
}

export class WorkerRunError extends Error {
  readonly terminalState: "failed_to_start" | "timed_out";
  readonly workerStderr?: string;
  readonly workerStderrPreview?: string;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      terminalState?: "failed_to_start" | "timed_out";
      workerStderr?: string;
      workerStderrPreview?: string;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "WorkerRunError";
    this.terminalState = options.terminalState ?? "failed_to_start";
    this.workerStderr = options.workerStderr;
    this.workerStderrPreview = options.workerStderrPreview;
  }
}

export class FakeWorkerBackend implements WorkerBackend {
  async run(input: WorkerInput): Promise<WorkerResult> {
    const delayMs = Number(process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS ?? "0");
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const target = "repo" in input.request.target ? `repo ${input.request.target.repo}` : "shell";
    const finalResponse =
      process.env.CODEX_FLEET_FAKE_WORKER_RESPONSE ??
      `fake worker accepted ${input.request.deliveryMode} task for ${target}`;
    return {
      exitCode: 0,
      finalResponse,
      finalResponsePreview: preview(finalResponse),
      codexThreadId: input.codexThreadId ?? `fake-thread-${input.taskId}`,
      workerStderr: process.env.CODEX_FLEET_FAKE_WORKER_STDERR,
      workerStderrPreview: process.env.CODEX_FLEET_FAKE_WORKER_STDERR
        ? preview(process.env.CODEX_FLEET_FAKE_WORKER_STDERR)
        : undefined
    };
  }
}

function preview(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
