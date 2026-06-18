import type { DelegateTaskRequest } from "@codex-fleet/shared";

export type WorkerInput = {
  taskId: string;
  request: DelegateTaskRequest;
  repoBaseCheckout?: string;
  worktreePath?: string;
  branch?: string;
  codexThreadId?: string;
};

export type WorkerResult = {
  exitCode: number;
  finalResponse: string;
  finalResponsePreview: string;
  codexThreadId?: string;
};

export interface WorkerBackend {
  run(input: WorkerInput): Promise<WorkerResult> | WorkerResult;
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
      codexThreadId: input.codexThreadId ?? `fake-thread-${input.taskId}`
    };
  }
}

function preview(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
