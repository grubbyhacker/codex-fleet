import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("cli views", () => {
  it("lists and reads tasks through daemon rpc", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-cli-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "cli", "cli");
    const rpc = { socketPath: paths.socketPath, clientId: "cli", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "cli fixture"
      })) as { taskId: string };

      const listed = await runCli(root, "list");
      expect(listed).toContain(delegated.taskId);

      const status = await runCli(root, "status", delegated.taskId);
      expect(status).toContain("exited");

      const logs = await runCli(root, "logs", delegated.taskId);
      expect(logs).toContain("task_created");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function runCli(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, "run", "packages/cli/src/index.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...stringEnv(process.env),
      CODEX_FLEET_STATE_DIR: root,
      CODEX_FLEET_CLIENT_ID: "cli"
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
    throw new Error(`CLI exited ${exitCode}: ${stderr}`);
  }
  return stdout;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}
