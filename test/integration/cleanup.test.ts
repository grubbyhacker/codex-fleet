import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("cleanup", () => {
  it("removes clean worktrees on end_task and blocks dirty worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-cleanup-"));
    const repo = join(root, "base-repo");
    initRepo(repo);
    const paths = resolveFleetPaths(join(root, "fleet"));
    mkdirSync(paths.rootDir, { recursive: true });
    writeFileSync(
      paths.reposPath,
      `${JSON.stringify({
        repos: [{ alias: "fixture", baseCheckout: repo, defaultBranch: "main" }]
      })}\n`
    );

    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const clean = await delegatePatch(rpc);
      const cleanTask = await getTask(rpc, clean.taskId);
      expect(existsSync(cleanTask.worktreePath ?? "")).toBe(true);
      expect(branchExists(repo, cleanTask.branch ?? "")).toBe(true);
      const previousPath = process.env.PATH;
      process.env.PATH = "";
      try {
        await callDaemon(rpc, "end_task", { taskId: clean.taskId });
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
      expect(existsSync(cleanTask.worktreePath ?? "")).toBe(false);
      expect(branchExists(repo, cleanTask.branch ?? "")).toBe(false);

      const dirty = await delegatePatch(rpc);
      const dirtyTask = await getTask(rpc, dirty.taskId);
      writeFileSync(join(dirtyTask.worktreePath ?? "", "dirty.txt"), "do not delete\n");
      await expect(callDaemon(rpc, "end_task", { taskId: dirty.taskId })).rejects.toThrow(
        "cleanup_blocked_dirty"
      );
      expect(existsSync(dirtyTask.worktreePath ?? "")).toBe(true);
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function delegatePatch(rpc: { socketPath: string; clientId: string; token: string }) {
  return (await callDaemon(rpc, "delegate_task", {
    target: { repo: "fixture" },
    deliveryMode: "patch",
    prompt: "patch"
  })) as { taskId: string };
}

async function getTask(
  rpc: { socketPath: string; clientId: string; token: string },
  taskId: string
) {
  const result = (await callDaemon(rpc, "get_task", { taskId })) as {
    task: { branch?: string; worktreePath?: string };
  };
  return result.task;
}

function branchExists(repo: string, branch: string): boolean {
  if (!branch) {
    return false;
  }
  return execFileSync("git", ["branch", "--list", branch], {
    cwd: repo,
    encoding: "utf8"
  }).includes(branch);
}

function initRepo(path: string): void {
  execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: path, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Codex Fleet Test",
      "-c",
      "user.email=fleet@example.test",
      "commit",
      "-m",
      "init"
    ],
    { cwd: path, stdio: "ignore" }
  );
}
