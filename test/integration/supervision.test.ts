import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";
import { EventLog } from "../../packages/daemon/src/store/event-log.js";
import { WorkerRunError, type WorkerBackend } from "../../packages/daemon/src/workers/backend.js";

describe("supervision and waiting", () => {
  it("marks old running tasks stale and returns event deltas", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-supervision-"));
    const paths = resolveFleetPaths(root);
    const client = createClient(paths, "orch", "orchestrator");
    const old = "2026-06-17T00:00:00.000Z";
    const log = new EventLog(paths.eventsPath);
    log.append({
      taskId: "task-stale",
      seq: 0,
      ts: old,
      type: "task_created",
      summary: JSON.stringify({
        target: { shell: true },
        deliveryMode: "research_only",
        risk: "standard",
        promptPreview: "quiet task",
        ownerSession: { clientId: "orch" },
        createdAt: old
      })
    });
    log.append({
      taskId: "task-stale",
      seq: 1,
      ts: old,
      type: "task_state",
      summary: JSON.stringify({
        state: "running",
        lastActivityAt: old
      })
    });

    const daemon = await startDaemon(paths);
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };
    try {
      const listed = (await callDaemon(rpc, "list_tasks", {})) as {
        tasks: Array<{ id: string; state: string }>;
      };
      expect(listed.tasks).toContainEqual(
        expect.objectContaining({ id: "task-stale", state: "stale" })
      );

      const waited = (await callDaemon(rpc, "wait_tasks", {
        taskIds: ["task-stale"],
        sinceEventSeq: 1,
        maxWaitSeconds: 1
      })) as { events: Array<{ type: string; seq: number }>; snapshots: Array<{ state: string }> };
      expect(waited.events).toContainEqual(expect.objectContaining({ type: "task_state" }));
      expect(waited.snapshots[0]?.state).toBe("stale");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("records worker activity without changing running state", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-activity-"));
    const paths = resolveFleetPaths(root);
    const client = createClient(paths, "orch", "orchestrator");
    const backend: WorkerBackend = {
      async run(input) {
        input.onActivity?.({ kind: "heartbeat", detail: "test-progress" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          exitCode: 0,
          finalResponse: "done",
          finalResponsePreview: "done",
          codexThreadId: `fake-thread-${input.taskId}`
        };
      }
    };
    const daemon = await startDaemon(paths, backend);
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "activity"
      })) as { taskId: string };
      const task = await waitForState(rpc, delegated.taskId, "exited");
      expect(task.task.lastActivityAt).toBeTruthy();

      const history = (await callDaemon(rpc, "get_task_history", {
        taskId: delegated.taskId
      })) as { events: Array<{ type: string; summary: string }> };
      const activity = history.events.find((event) => event.type === "task_activity");
      expect(activity).toBeTruthy();
      expect(JSON.parse(activity?.summary ?? "{}")).toMatchObject({
        kind: "heartbeat",
        detail: "test-progress"
      });
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("records worker timeouts as timed_out", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-worker-timeout-"));
    const paths = resolveFleetPaths(root);
    const client = createClient(paths, "orch", "orchestrator");
    const backend: WorkerBackend = {
      run() {
        throw new WorkerRunError("MCP error -32001: Request timed out", {
          terminalState: "timed_out"
        });
      }
    };
    const daemon = await startDaemon(paths, backend);
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "timeout"
      })) as { taskId: string };
      const task = await waitForState(rpc, delegated.taskId, "timed_out");
      expect(task.task.finalResponse).toBe("MCP error -32001: Request timed out");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function waitForState(
  rpc: { socketPath: string; clientId: string; token: string },
  taskId: string,
  state: string
): Promise<{ task: { state: string; finalResponse?: string; lastActivityAt?: string } }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = (await callDaemon(rpc, "get_task", { taskId })) as {
      task: { state: string; finalResponse?: string; lastActivityAt?: string };
    };
    if (result.task.state === state) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (await callDaemon(rpc, "get_task", { taskId })) as {
    task: { state: string; finalResponse?: string; lastActivityAt?: string };
  };
}
