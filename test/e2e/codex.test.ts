import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

const runCodexE2e = process.env.CODEX_FLEET_RUN_CODEX_E2E === "1";
const describeCodex = runCodexE2e ? describe : describe.skip;

describeCodex("real codex e2e", () => {
  it("runs a minimal shell research task through the daemon", async () => {
    const model = process.env.CODEX_FLEET_E2E_MODEL ?? "gpt-5.3-codex-spark";
    console.warn(`Running paid Codex E2E with model ${model}`);

    const root = mkdtempSync(join(tmpdir(), "codex-fleet-e2e-"));
    const paths = resolveFleetPaths(root);
    const previousBackend = process.env.CODEX_FLEET_WORKER_BACKEND;
    process.env.CODEX_FLEET_WORKER_BACKEND = "codex";
    process.env.CODEX_FLEET_CODEX_TIMEOUT_MS = process.env.CODEX_FLEET_CODEX_TIMEOUT_MS ?? "120000";
    process.env.CODEX_FLEET_E2E_MODEL = model;

    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        modelTier: "cheap",
        prompt: "Reply with exactly: codex-fleet-e2e-ok"
      })) as { taskId: string };
      const task = await waitForExit(rpc, delegated.taskId);
      expect(task.task.state).toBe("exited");
      expect(task.task.finalResponsePreview).toContain("codex-fleet-e2e-ok");
    } finally {
      if (previousBackend === undefined) {
        delete process.env.CODEX_FLEET_WORKER_BACKEND;
      } else {
        process.env.CODEX_FLEET_WORKER_BACKEND = previousBackend;
      }
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function waitForExit(
  rpc: { socketPath: string; clientId: string; token: string },
  taskId: string
): Promise<{ task: { state: string; finalResponsePreview?: string } }> {
  let sinceEventSeq = 1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const waited = (await callDaemon(rpc, "wait_tasks", {
      taskIds: [taskId],
      sinceEventSeq,
      maxWaitSeconds: 10
    })) as {
      snapshots: Array<{ state: string; finalResponsePreview?: string }>;
      events: Array<{ seq: number }>;
    };
    sinceEventSeq = Math.max(sinceEventSeq, ...waited.events.map((event) => event.seq));
    const snapshot = waited.snapshots[0];
    if (snapshot?.state === "exited") {
      return { task: snapshot };
    }
  }
  return (await callDaemon(rpc, "get_task", { taskId })) as {
    task: { state: string; finalResponsePreview?: string };
  };
}
