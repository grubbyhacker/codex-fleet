import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";
import type { WorkerBackend } from "../../packages/daemon/src/workers/backend.js";

describe("repo registry and worktree isolation", () => {
  it("creates distinct worktrees and branches for parallel repo tasks", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-worktree-"));
    const repo = join(root, "base-repo");
    initRepo(repo);

    const paths = resolveFleetPaths(join(root, "fleet"));
    mkdirSync(paths.rootDir, { recursive: true });
    writeFileSync(
      paths.reposPath,
      `${JSON.stringify({
        repos: [
          {
            alias: "fixture",
            baseCheckout: repo,
            defaultBranch: "main",
            branchProtected: true,
            verifyCommands: ["bun test"],
            defaultModelTier: "standard"
          }
        ]
      })}\n`
    );

    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const targets = (await callDaemon(rpc, "list_targets", {})) as {
        targets: Array<{ id: string }>;
      };
      expect(targets.targets.map((target) => target.id)).toContain("fixture");

      const first = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "patch",
        prompt: "first"
      })) as { taskId: string };
      const second = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "patch",
        prompt: "second"
      })) as { taskId: string };

      const firstTask = (await callDaemon(rpc, "get_task", { taskId: first.taskId })) as {
        task: { branch?: string; worktreePath?: string };
      };
      const secondTask = (await callDaemon(rpc, "get_task", { taskId: second.taskId })) as {
        task: { branch?: string; worktreePath?: string };
      };

      expect(firstTask.task.worktreePath).toBeTruthy();
      expect(secondTask.task.worktreePath).toBeTruthy();
      expect(firstTask.task.worktreePath).not.toBe(secondTask.task.worktreePath);
      expect(firstTask.task.branch).not.toBe(secondTask.task.branch);
      expect(existsSync(firstTask.task.worktreePath ?? "")).toBe(true);
      expect(existsSync(secondTask.task.worktreePath ?? "")).toBe(true);
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# fixture\n");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("creates repo worktrees from freshly fetched origin default branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-worktree-origin-"));
    const repo = join(root, "base-repo");
    const remote = join(root, "remote.git");
    const updater = join(root, "updater");
    initRepo(repo);
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["clone", remote, updater], { stdio: "ignore" });
    writeFileSync(join(updater, "REMOTE.md"), "# remote-only\n");
    execFileSync("git", ["add", "REMOTE.md"], { cwd: updater, stdio: "ignore" });
    commit(updater, "advance origin main");
    execFileSync("git", ["push", "origin", "main"], { cwd: updater, stdio: "ignore" });

    const paths = resolveFleetPaths(join(root, "fleet"));
    writeRepoRegistry(paths.rootDir, paths.reposPath, repo);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      expect(existsSync(join(repo, "REMOTE.md"))).toBe(false);
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "patch",
        prompt: "inspect fresh base"
      })) as { taskId: string };
      const task = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { worktreePath?: string };
      };
      expect(readFileSync(join(task.task.worktreePath ?? "", "REMOTE.md"), "utf8")).toBe(
        "# remote-only\n"
      );
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("creates worktrees from Fleet-owned mirrors for remoteUrl repos", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-worktree-mirror-"));
    const seed = join(root, "seed-repo");
    const remote = join(root, "remote.git");
    initRepo(seed);
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seed, stdio: "ignore" });

    const paths = resolveFleetPaths(join(root, "fleet"));
    writeRemoteRepoRegistry(paths.rootDir, paths.reposPath, remote);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "patch",
        prompt: "patch from mirror"
      })) as { taskId: string };
      const task = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { branch?: string; worktreePath?: string };
      };

      expect(existsSync(join(paths.reposDir, "fixture.git"))).toBe(true);
      expect(task.task.worktreePath).toContain(join(paths.worktreesDir, "fixture"));
      expect(task.task.branch).toMatch(/^fleet\/fixture\//);
      expect(readFileSync(join(task.task.worktreePath ?? "", "README.md"), "utf8")).toBe(
        "# fixture\n"
      );
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("creates detached research worktrees for remoteUrl repos", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-worktree-research-mirror-"));
    const seed = join(root, "seed-repo");
    const remote = join(root, "remote.git");
    initRepo(seed);
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seed, stdio: "ignore" });

    const paths = resolveFleetPaths(join(root, "fleet"));
    writeRemoteRepoRegistry(paths.rootDir, paths.reposPath, remote);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "research_only",
        prompt: "research from mirror"
      })) as { taskId: string };
      const task = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { branch?: string; worktreePath?: string };
      };

      expect(task.task.branch).toBeUndefined();
      expect(task.task.worktreePath).toContain(join(paths.worktreesDir, "fixture"));
      expect(readFileSync(join(task.task.worktreePath ?? "", "README.md"), "utf8")).toBe(
        "# fixture\n"
      );
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports review tasks that leave uncommitted files and empty branches", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-worktree-postcheck-"));
    const repo = join(root, "base-repo");
    initRepo(repo);

    const paths = resolveFleetPaths(join(root, "fleet"));
    writeRepoRegistry(paths.rootDir, paths.reposPath, repo);

    const backend: WorkerBackend = {
      run(input) {
        writeFileSync(join(input.worktreePath ?? "", "REVIEW.md"), "draft review notes\n");
        return {
          exitCode: 0,
          finalResponse: "worker says done",
          finalResponsePreview: "worker says done",
          codexThreadId: `fake-thread-${input.taskId}`
        };
      }
    };
    const daemon = await startDaemon(paths, backend);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "pr_for_review",
        prompt: "write a review doc"
      })) as { taskId: string };

      const task = await waitUntilExited(rpc, delegated.taskId);
      expect(task.task.finalResponse).toContain("worker says done");
      expect(task.task.finalResponse).toContain("worktree has 1 uncommitted file(s)");
      expect(task.task.finalResponse).toContain("branch has no commits ahead of main");

      const history = (await callDaemon(rpc, "get_task_history", {
        taskId: delegated.taskId
      })) as { events: Array<{ type: string; summary: string }> };
      const worktreeStatus = history.events.find((event) => event.type === "worktree_status");
      expect(worktreeStatus).toBeTruthy();
      expect(JSON.parse(worktreeStatus?.summary ?? "{}")).toMatchObject({
        dirtyFiles: 1,
        untrackedFiles: 1,
        aheadOfBase: 0,
        attention: [
          "Fleet post-check: worktree has 1 uncommitted file(s) after pr_for_review.",
          "Fleet post-check: branch has no commits ahead of main."
        ]
      });
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function waitUntilExited(
  rpc: { socketPath: string; clientId: string; token: string },
  taskId: string
): Promise<{ task: { state: string; finalResponse?: string } }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = (await callDaemon(rpc, "get_task", { taskId })) as {
      task: { state: string; finalResponse?: string };
    };
    if (result.task.state === "exited") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (await callDaemon(rpc, "get_task", { taskId })) as {
    task: { state: string; finalResponse?: string };
  };
}

function writeRepoRegistry(rootDir: string, reposPath: string, repo: string): void {
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(
    reposPath,
    `${JSON.stringify({
      repos: [
        {
          alias: "fixture",
          baseCheckout: repo,
          defaultBranch: "main",
          branchProtected: true,
          verifyCommands: ["bun test"],
          defaultModelTier: "standard"
        }
      ]
    })}\n`
  );
}

function writeRemoteRepoRegistry(rootDir: string, reposPath: string, remoteUrl: string): void {
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(
    reposPath,
    `${JSON.stringify({
      repos: [
        {
          alias: "fixture",
          remoteUrl,
          defaultBranch: "main",
          branchProtected: true,
          verifyCommands: ["bun test"],
          defaultModelTier: "standard"
        }
      ]
    })}\n`
  );
}

function initRepo(path: string): void {
  execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: path, stdio: "ignore" });
  commit(path, "init");
}

function commit(path: string, message: string): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Codex Fleet Test",
      "-c",
      "user.email=fleet@example.test",
      "commit",
      "-m",
      message
    ],
    { cwd: path, stdio: "ignore" }
  );
}
