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
  run(input: WorkerInput): WorkerResult;
}

export class FakeWorkerBackend implements WorkerBackend {
  run(input: WorkerInput): WorkerResult {
    const target = "repo" in input.request.target ? `repo ${input.request.target.repo}` : "shell";
    return {
      exitCode: 0,
      finalResponsePreview: `fake worker accepted ${input.request.deliveryMode} task for ${target}`
    };
  }
}
