import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("cleanup", () => {
  it("does not release active task resources before the worker reaches a terminal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-active-cleanup-"));
    const paths = resolveFleetPaths(root);
    const previousDelay = process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS;
    process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS = "250";
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "active shell scratch"
      })) as { taskId: string };
      const running = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { shellPath?: string; state: string };
      };
      expect(running.task.state).toBe("running");
      expect(existsSync(running.task.shellPath ?? "")).toBe(true);

      await expect(callDaemon(rpc, "end_task", { taskId: delegated.taskId })).rejects.toThrow(
        "wait for a terminal state"
      );
      expect(existsSync(running.task.shellPath ?? "")).toBe(true);

      await callDaemon(rpc, "wait_tasks", {
        taskIds: [delegated.taskId],
        sinceEventSeq: 999,
        maxWaitSeconds: 1,
        returnOnStatuses: ["exited"]
      });
      await callDaemon(rpc, "end_task", { taskId: delegated.taskId });
      expect(existsSync(running.task.shellPath ?? "")).toBe(false);
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

  it("allocates and removes Fleet-owned shell scratch directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-shell-cleanup-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "shell scratch"
      })) as { taskId: string };
      const task = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { shellPath?: string };
      };
      expect(task.task.shellPath).toContain(paths.shellDir);
      expect(existsSync(task.task.shellPath ?? "")).toBe(true);

      await callDaemon(rpc, "end_task", { taskId: delegated.taskId });
      expect(existsSync(task.task.shellPath ?? "")).toBe(false);
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

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
      const ignoredCache = join(cleanTask.worktreePath ?? "", ".cache", "module");
      mkdirSync(ignoredCache, { recursive: true });
      writeFileSync(join(ignoredCache, "artifact"), "generated\n");
      chmodSync(join(ignoredCache, "artifact"), 0o444);
      chmodSync(ignoredCache, 0o555);
      chmodSync(join(cleanTask.worktreePath ?? "", ".cache"), 0o555);
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
      const preservedCache = join(dirtyTask.worktreePath ?? "", ".cache");
      mkdirSync(preservedCache, { recursive: true });
      writeFileSync(join(preservedCache, "artifact"), "preserve while dirty\n");
      chmodSync(join(preservedCache, "artifact"), 0o444);
      await expect(callDaemon(rpc, "end_task", { taskId: dirty.taskId })).rejects.toThrow(
        "cleanup_blocked_dirty"
      );
      expect(existsSync(dirtyTask.worktreePath ?? "")).toBe(true);
      expect(existsSync(join(preservedCache, "artifact"))).toBe(true);
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
  writeFileSync(join(path, ".gitignore"), ".cache/\n");
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: path, stdio: "ignore" });
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
