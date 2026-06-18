import type { DelegateTaskRequest } from "@codex-fleet/shared";

export type WorkerInput = {
  taskId: string;
  request: DelegateTaskRequest;
  worktreePath?: string;
  branch?: string;
};

export type WorkerResult = {
  exitCode: number;
  finalResponsePreview: string;
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
    return {
      exitCode: 0,
      finalResponsePreview: `fake worker accepted ${input.request.deliveryMode} task for ${target}`
    };
  }
}
