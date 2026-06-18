import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("daemon rpc", () => {
  it("authenticates, authorizes, delegates fake tasks, and survives service restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-rpc-"));
    const paths = resolveFleetPaths(root);
    let daemon = await startDaemon(paths);

    try {
      const orchestrator = createClient(paths, "orch", "orchestrator");
      const dashboard = createClient(paths, "dash", "dashboard");

      await expect(
        callDaemon(
          { socketPath: paths.socketPath, clientId: "orch", token: "wrong-token" },
          "list_targets",
          {}
        )
      ).rejects.toThrow("unauthenticated");

      await expect(
        callDaemon(
          { socketPath: paths.socketPath, clientId: "dash", token: dashboard.token },
          "delegate_task",
          {
            target: { shell: true },
            deliveryMode: "research_only",
            prompt: "hello"
          }
        )
      ).rejects.toThrow("forbidden");

      await callDaemon(
        { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token },
        "initialize",
        { sessionName: "phase-1" }
      );

      const delegated = (await callDaemon(
        { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token },
        "delegate_task",
        {
          target: { shell: true },
          deliveryMode: "research_only",
          prompt: "hello"
        }
      )) as { taskId: string };

      const taskBeforeRestart = (await callDaemon(
        { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token },
        "get_task",
        { taskId: delegated.taskId }
      )) as { task: { state: string } };
      expect(taskBeforeRestart.task.state).toBe("exited");

      await daemon.close();
      daemon = await startDaemon(paths);

      const taskAfterRestart = (await callDaemon(
        { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token },
        "get_task",
        { taskId: delegated.taskId }
      )) as { task: { state: string } };
      expect(taskAfterRestart.task.state).toBe("exited");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("returns from delegate_task before delayed worker completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-rpc-async-"));
    const paths = resolveFleetPaths(root);
    const previousDelay = process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS;
    process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS = "250";
    const daemon = await startDaemon(paths);
    const orchestrator = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      const startedAt = performance.now();
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "delayed fake worker"
      })) as { taskId: string };
      const elapsed = performance.now() - startedAt;
      expect(elapsed).toBeLessThan(200);

      const running = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { state: string };
      };
      expect(running.task.state).toBe("running");

      const waited = (await callDaemon(rpc, "wait_tasks", {
        taskIds: [delegated.taskId],
        sinceEventSeq: 1,
        maxWaitSeconds: 1
      })) as { snapshots: Array<{ state: string }>; events: Array<{ type: string }> };
      expect(waited.snapshots[0]?.state).toBe("exited");
      expect(waited.events).toContainEqual(expect.objectContaining({ type: "task_state" }));
    } finally {
      if (previousDelay === undefined) {
        delete process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS;
      } else {
        process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS = previousDelay;
      }
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("persists full final responses separately from previews", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-rpc-final-response-"));
    const paths = resolveFleetPaths(root);
    const previousResponse = process.env.CODEX_FLEET_FAKE_WORKER_RESPONSE;
    const fullResponse = Array.from({ length: 40 }, (_, index) => `line-${index}`).join(
      " detailed final answer "
    );
    process.env.CODEX_FLEET_FAKE_WORKER_RESPONSE = fullResponse;
    let daemon = await startDaemon(paths);
    const orchestrator = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "long final response"
      })) as { taskId: string };
      const task = await waitUntilExited(rpc, delegated.taskId);
      expect(task.task.finalResponse).toBe(fullResponse);
      expect(task.task.finalResponsePreview).not.toBe(fullResponse);
      expect(task.task.finalResponsePreview?.length).toBeLessThan(fullResponse.length);

      const waited = (await callDaemon(rpc, "wait_tasks", {
        taskIds: [delegated.taskId],
        sinceEventSeq: 999,
        returnOnStatuses: ["exited"],
        maxWaitSeconds: 1
      })) as {
        snapshots: Array<{ finalResponse?: string; finalResponsePreview?: string }>;
      };
      expect(waited.snapshots[0]?.finalResponse).toBe(fullResponse);

      const history = (await callDaemon(rpc, "get_task_history", {
        taskId: delegated.taskId
      })) as { events: Array<{ type: string; summary: string }> };
      const exited = [...history.events].reverse().find((event) => event.type === "task_state");
      expect(exited).toBeTruthy();
      expect(JSON.parse(exited?.summary ?? "{}")).toMatchObject({
        finalResponse: fullResponse
      });

      await daemon.close();
      daemon = await startDaemon(paths);
      const afterRestart = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { finalResponse?: string };
      };
      expect(afterRestart.task.finalResponse).toBe(fullResponse);
    } finally {
      if (previousResponse === undefined) {
        delete process.env.CODEX_FLEET_FAKE_WORKER_RESPONSE;
      } else {
        process.env.CODEX_FLEET_FAKE_WORKER_RESPONSE = previousResponse;
      }
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("persists worker stderr separately from final responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-rpc-stderr-"));
    const paths = resolveFleetPaths(root);
    const previousStderr = process.env.CODEX_FLEET_FAKE_WORKER_STDERR;
    const stderr = Array.from({ length: 40 }, (_, index) => `stderr-${index}`).join(
      " diagnostic line "
    );
    process.env.CODEX_FLEET_FAKE_WORKER_STDERR = stderr;
    let daemon = await startDaemon(paths);
    const orchestrator = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "stderr fixture"
      })) as { taskId: string };
      const task = await waitUntilExited(rpc, delegated.taskId);
      expect(task.task.workerStderr).toBe(stderr);
      expect(task.task.workerStderrPreview).not.toBe(stderr);
      expect(task.task.workerStderrPreview?.length).toBeLessThan(stderr.length);

      const waited = (await callDaemon(rpc, "wait_tasks", {
        taskIds: [delegated.taskId],
        sinceEventSeq: 999,
        returnOnStatuses: ["exited"],
        maxWaitSeconds: 1
      })) as {
        snapshots: Array<{ workerStderr?: string; workerStderrPreview?: string }>;
      };
      expect(waited.snapshots[0]?.workerStderr).toBe(stderr);

      const history = (await callDaemon(rpc, "get_task_history", {
        taskId: delegated.taskId
      })) as { events: Array<{ type: string; summary: string }> };
      const exited = [...history.events].reverse().find((event) => event.type === "task_state");
      expect(JSON.parse(exited?.summary ?? "{}")).toMatchObject({
        workerStderr: stderr
      });

      await daemon.close();
      daemon = await startDaemon(paths);
      const afterRestart = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { workerStderr?: string };
      };
      expect(afterRestart.task.workerStderr).toBe(stderr);
    } finally {
      if (previousStderr === undefined) {
        delete process.env.CODEX_FLEET_FAKE_WORKER_STDERR;
      } else {
        process.env.CODEX_FLEET_FAKE_WORKER_STDERR = previousStderr;
      }
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resumes an exited task on the same task id and worker thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-rpc-resume-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const orchestrator = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "first turn"
      })) as { taskId: string };
      const first = await waitUntilExited(rpc, delegated.taskId);
      expect(first.task.codexThreadId).toBe(`fake-thread-${delegated.taskId}`);

      const resumed = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        resumeTaskId: delegated.taskId,
        prompt: "second turn"
      })) as { taskId: string };
      expect(resumed.taskId).toBe(delegated.taskId);

      const second = await waitUntilExited(rpc, delegated.taskId);
      expect(second.task.codexThreadId).toBe(first.task.codexThreadId);
      const history = (await callDaemon(rpc, "get_task_history", {
        taskId: delegated.taskId
      })) as { events: Array<{ type: string }> };
      expect(history.events).toContainEqual(expect.objectContaining({ type: "task_resumed" }));
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("returns immediately when returnOnStatuses already matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-rpc-return-status-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const orchestrator = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "return status"
      })) as { taskId: string };
      await waitUntilExited(rpc, delegated.taskId);

      const startedAt = performance.now();
      const waited = (await callDaemon(rpc, "wait_tasks", {
        taskIds: [delegated.taskId],
        sinceEventSeq: 999,
        maxWaitSeconds: 1,
        returnOnStatuses: ["exited"]
      })) as { snapshots: Array<{ state: string }> };
      expect(performance.now() - startedAt).toBeLessThan(200);
      expect(waited.snapshots[0]?.state).toBe("exited");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function waitUntilExited(
  rpc: { socketPath: string; clientId: string; token: string },
  taskId: string
): Promise<{
  task: {
    state: string;
    codexThreadId?: string;
    finalResponse?: string;
    finalResponsePreview?: string;
    workerStderr?: string;
    workerStderrPreview?: string;
  };
}> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = (await callDaemon(rpc, "get_task", { taskId })) as {
      task: {
        state: string;
        codexThreadId?: string;
        finalResponse?: string;
        finalResponsePreview?: string;
        workerStderr?: string;
        workerStderrPreview?: string;
      };
    };
    if (result.task.state === "exited") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (await callDaemon(rpc, "get_task", { taskId })) as {
    task: {
      state: string;
      codexThreadId?: string;
      finalResponse?: string;
      finalResponsePreview?: string;
      workerStderr?: string;
      workerStderrPreview?: string;
    };
  };
}
