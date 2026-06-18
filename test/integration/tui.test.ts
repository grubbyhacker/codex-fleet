import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("tui dashboard", () => {
  it("renders fleet-wide read-only task data for a dashboard client", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-tui-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const orchestrator = createClient(paths, "orch", "orchestrator");
    createClient(paths, "dashboard", "dashboard");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      await callDaemon(rpc, "initialize", { sessionName: "tui-session" });
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "show in dashboard"
      })) as { taskId: string };

      const output = await runTui(root, "--once", "--json", "--task", delegated.taskId);
      expect(output.rendered).toContain("Codex Fleet");
      expect(output.rendered).toContain("orch/tui-session");
      expect(output.rendered).toContain(delegated.taskId);
      expect(output.tasks).toContainEqual(expect.objectContaining({ id: delegated.taskId }));
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function runTui(
  root: string,
  ...args: string[]
): Promise<{
  rendered: string;
  tasks: Array<{ id: string }>;
}> {
  const proc = Bun.spawn([process.execPath, "run", "packages/tui/src/index.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...stringEnv(process.env),
      CODEX_FLEET_STATE_DIR: root,
      CODEX_FLEET_CLIENT_ID: "dashboard"
    },
    stderr: "pipe",
    stdout: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`TUI exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as { rendered: string; tasks: Array<{ id: string }> };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}
