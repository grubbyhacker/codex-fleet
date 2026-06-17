import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("model tier routing", () => {
  it("records requested and actual model tier with safe upgrades", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-model-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "full_delivery",
        risk: "high",
        modelTier: "cheap",
        prompt: "high risk"
      })) as { taskId: string };
      const result = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { requestedModel?: string; actualModel?: string };
      };

      expect(result.task.requestedModel).toBe("cheap");
      expect(result.task.actualModel).toBe("strong");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});
