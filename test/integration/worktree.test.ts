import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

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
});

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
