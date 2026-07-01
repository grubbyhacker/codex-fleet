import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import {
  dirtyWorktreeStopHook,
  ensureDirtyWorktreeStopHookScript,
  shouldInstallDirtyWorktreeStopHook
} from "../../packages/daemon/src/workers/dirty-worktree-stop-hook.js";

describe("dirty worktree stop hook", () => {
  it("is only installed for repo delivery modes that should end cleanly", () => {
    expect(
      shouldInstallDirtyWorktreeStopHook({
        taskId: "task-review",
        worktreePath: "/tmp/worktree",
        request: {
          target: { repo: "fixture" },
          deliveryMode: "pr_for_review",
          risk: "standard",
          prompt: "open a PR"
        }
      })
    ).toBe(true);

    expect(
      shouldInstallDirtyWorktreeStopHook({
        taskId: "task-patch",
        worktreePath: "/tmp/worktree",
        request: {
          target: { repo: "fixture" },
          deliveryMode: "patch",
          risk: "standard",
          prompt: "return a patch"
        }
      })
    ).toBe(false);

    expect(
      shouldInstallDirtyWorktreeStopHook({
        taskId: "task-shell",
        shellPath: "/tmp/shell",
        request: {
          target: { shell: true },
          deliveryMode: "full_delivery",
          risk: "standard",
          prompt: "deploy"
        }
      })
    ).toBe(false);
  });

  it("generates a task-specific hook command under Fleet state", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-stop-hook-command-"));
    const paths = resolveFleetPaths(join(root, "fleet"));

    try {
      const hook = dirtyWorktreeStopHook(paths, {
        taskId: "task-1",
        worktreePath: join(root, "worktree"),
        request: {
          target: { repo: "fixture" },
          deliveryMode: "full_delivery",
          risk: "standard",
          prompt: "finish"
        }
      });

      expect(hook).toBeTruthy();
      expect(hook?.command).toContain(paths.hooksDir);
      expect(hook?.command).toContain("CODEX_FLEET_STOP_HOOK_DELIVERY_MODE='full_delivery'");
      expect(hook?.command).toContain(join(paths.tasksDir, "stop-hook-attempts"));
      expect(existsSync(join(paths.hooksDir, "dirty-worktree-stop-hook.sh"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("blocks dirty worktree stops up to the configured nudge cap", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-stop-hook-script-"));
    const repo = join(root, "repo");
    const paths = resolveFleetPaths(join(root, "fleet"));
    const attemptsPath = join(paths.tasksDir, "stop-hook-attempts", "task-1.attempts");

    try {
      initRepo(repo);
      const scriptPath = ensureDirtyWorktreeStopHookScript(paths);

      expect(runHook(scriptPath, repo, attemptsPath)).toBe("");
      expect(existsSync(attemptsPath)).toBe(false);

      writeFileSync(join(repo, "dirty.txt"), "dirty\n");
      const first = runHook(scriptPath, repo, attemptsPath);
      expect(first).toContain('"decision":"block"');
      expect(first).toContain("This pr_for_review task must not stop with a dirty worktree");
      expect(first).toContain("Do not discard intended changes");
      expect(first).toContain("push the branch, open or report the PR URL");
      expect(first).toContain("git status --short");
      expect(first).toContain("Nudge 1/2");
      expect(readFileSync(attemptsPath, "utf8")).toBe("1\n");

      const second = runHook(scriptPath, repo, attemptsPath);
      expect(second).toContain('"decision":"block"');
      expect(second).toContain("Nudge 2/2");
      expect(readFileSync(attemptsPath, "utf8")).toBe("2\n");

      expect(runHook(scriptPath, repo, attemptsPath)).toBe("");
      expect(readFileSync(attemptsPath, "utf8")).toBe("2\n");

      unlinkSync(join(repo, "dirty.txt"));
      expect(runHook(scriptPath, repo, attemptsPath)).toBe("");
      expect(existsSync(attemptsPath)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("emits delivery-mode-specific guidance", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-stop-hook-guidance-"));
    const repo = join(root, "repo");
    const paths = resolveFleetPaths(join(root, "fleet"));
    const attemptsPath = join(paths.tasksDir, "stop-hook-attempts", "task-guidance.attempts");

    try {
      initRepo(repo);
      writeFileSync(join(repo, "dirty.txt"), "dirty\n");
      const scriptPath = ensureDirtyWorktreeStopHookScript(paths);

      const fullDelivery = runHook(scriptPath, repo, attemptsPath, "full_delivery");
      expect(fullDelivery).toContain("Reconcile the source-of-truth repo state");
      expect(fullDelivery).toContain("merge only when explicitly authorized");
      expect(fullDelivery).not.toContain("commit/push/merge");
      rmSync(attemptsPath, { force: true });
      expect(runHook(scriptPath, repo, attemptsPath, "push_to_main")).toContain(
        "push to the default branch"
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function runHook(
  scriptPath: string,
  cwd: string,
  attemptsPath: string,
  deliveryMode = "pr_for_review"
): string {
  return execFileSync(scriptPath, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_FLEET_GIT_PATH: "git",
      CODEX_FLEET_STOP_HOOK_ATTEMPTS_FILE: attemptsPath,
      CODEX_FLEET_STOP_HOOK_DELIVERY_MODE: deliveryMode,
      CODEX_FLEET_STOP_HOOK_MAX_NUDGES: "2"
    }
  });
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
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
