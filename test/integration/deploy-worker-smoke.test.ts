import { describe, expect, it } from "vitest";

import type { DaemonMethod, TaskSnapshot } from "../../packages/shared/src/index.js";
import {
  deployWorkerSmokeMarker,
  runDeployWorkerSmoke
} from "../../scripts/deploy-worker-smoke.js";

const baseTask: TaskSnapshot = {
  id: "smoke-task",
  target: { shell: true },
  deliveryMode: "research_only",
  risk: "low",
  state: "exited",
  ownerSession: { clientId: "cli" },
  promptPreview: "smoke",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:01.000Z",
  actualModelRoute: "gpt-5.6-luna",
  finalResponse: deployWorkerSmokeMarker
};

describe("deploy worker smoke", () => {
  it("runs a cheap Luna task through the daemon and releases it", async () => {
    const calls: Array<{ method: DaemonMethod; params: unknown }> = [];
    const result = await runDeployWorkerSmoke({
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "list_targets") return { targets: [] };
        if (method === "delegate_task") return { taskId: baseTask.id };
        if (method === "wait_tasks") {
          return { snapshots: [baseTask], events: [], nextEventSeq: 42 };
        }
        if (method === "get_task") return { task: baseTask };
        if (method === "end_task") return { accepted: true, taskId: baseTask.id };
        throw new Error(`Unexpected method ${method}`);
      }
    });

    expect(result).toEqual({
      taskId: baseTask.id,
      state: "exited",
      modelRoute: "gpt-5.6-luna",
      response: deployWorkerSmokeMarker,
      released: true
    });
    expect(calls.find((call) => call.method === "delegate_task")).toEqual({
      method: "delegate_task",
      params: {
        target: { shell: true },
        deliveryMode: "research_only",
        risk: "low",
        modelTier: "cheap",
        modelRoute: "gpt-5.6-luna",
        prompt: `Reply with exactly: ${deployWorkerSmokeMarker}`
      }
    });
    expect(calls.find((call) => call.method === "wait_tasks")).toMatchObject({
      method: "wait_tasks",
      params: {
        taskIds: [baseTask.id],
        wakeOn: "requested_status",
        snapshotDetail: "compact"
      }
    });
    expect(calls.at(-1)).toEqual({
      method: "end_task",
      params: {
        taskId: baseTask.id,
        reason: "local deployment worker smoke complete"
      }
    });
  });

  it.each([
    ["failed_to_start", "launcher missing"],
    ["exited", "wrong response"]
  ] as const)(
    "fails deployment for %s and still releases the terminal task",
    async (state, output) => {
      const task: TaskSnapshot = {
        ...baseTask,
        state,
        finalResponse: state === "exited" ? output : undefined,
        workerStderr: state === "failed_to_start" ? output : undefined
      };
      const methods: DaemonMethod[] = [];

      await expect(
        runDeployWorkerSmoke({
          call: async (method) => {
            methods.push(method);
            if (method === "list_targets") return { targets: [] };
            if (method === "delegate_task") return { taskId: task.id };
            if (method === "wait_tasks") {
              return { snapshots: [task], events: [], nextEventSeq: 2 };
            }
            if (method === "get_task") return { task };
            if (method === "end_task") return { accepted: true, taskId: task.id };
            throw new Error(`Unexpected method ${method}`);
          }
        })
      ).rejects.toThrow(state === "failed_to_start" ? "launcher missing" : "wrong response");

      expect(methods.at(-1)).toBe("end_task");
    }
  );

  it("rejects an unexpected model route and releases the task", async () => {
    const task: TaskSnapshot = { ...baseTask, actualModelRoute: "gpt-5.6-terra" };
    const methods: DaemonMethod[] = [];

    await expect(
      runDeployWorkerSmoke({
        call: async (method) => {
          methods.push(method);
          if (method === "list_targets") return { targets: [] };
          if (method === "delegate_task") return { taskId: task.id };
          if (method === "wait_tasks") {
            return { snapshots: [task], events: [], nextEventSeq: 2 };
          }
          if (method === "get_task") return { task };
          if (method === "end_task") return { accepted: true, taskId: task.id };
          throw new Error(`Unexpected method ${method}`);
        }
      })
    ).rejects.toThrow("used model route gpt-5.6-terra instead of gpt-5.6-luna");

    expect(methods.at(-1)).toBe("end_task");
  });

  it("fails within its deadline without releasing a task that may still be running", async () => {
    let now = 0;
    const methods: DaemonMethod[] = [];

    await expect(
      runDeployWorkerSmoke({
        timeoutMs: 1_500,
        now: () => {
          const current = now;
          now += 1_000;
          return current;
        },
        call: async (method) => {
          methods.push(method);
          if (method === "list_targets") return { targets: [] };
          if (method === "delegate_task") return { taskId: baseTask.id };
          if (method === "wait_tasks") {
            return {
              snapshots: [{ ...baseTask, state: "running", finalResponse: undefined }],
              events: [],
              nextEventSeq: 2
            };
          }
          throw new Error(`Unexpected method ${method}`);
        }
      })
    ).rejects.toThrow("did not reach a terminal state within 1500ms");

    expect(methods).not.toContain("end_task");
  });

  it("waits for RPC readiness before delegating", async () => {
    let readinessAttempts = 0;
    const delays: number[] = [];

    const result = await runDeployWorkerSmoke({
      readyRetryMs: 25,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      call: async (method) => {
        if (method === "list_targets") {
          readinessAttempts += 1;
          if (readinessAttempts === 1) throw new Error("connect ENOENT daemon.sock");
          return { targets: [] };
        }
        if (method === "delegate_task") return { taskId: baseTask.id };
        if (method === "wait_tasks") {
          return { snapshots: [baseTask], events: [], nextEventSeq: 2 };
        }
        if (method === "get_task") return { task: baseTask };
        if (method === "end_task") return { accepted: true, taskId: baseTask.id };
        throw new Error(`Unexpected method ${method}`);
      }
    });

    expect(readinessAttempts).toBe(2);
    expect(delays).toEqual([25]);
    expect(result.state).toBe("exited");
  });
});
