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
});
