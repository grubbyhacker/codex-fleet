import { execFileSync } from "node:child_process";

import type { TaskSnapshot } from "@codex-fleet/shared";

import type { RepoConfig } from "../registry/repo-registry.js";
import { FleetError } from "../rpc/errors.js";

export type CleanupResult = {
  cleaned: boolean;
  reason?: string;
};

export class CleanupManager {
  releaseWorktree(task: TaskSnapshot, repo?: RepoConfig): CleanupResult {
    if (!task.worktreePath) {
      return { cleaned: false, reason: "no_worktree" };
    }
    if (!repo) {
      return { cleaned: false, reason: "repo_missing" };
    }

    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: task.worktreePath,
      encoding: "utf8"
    }).trim();
    if (dirty.length > 0) {
      throw new FleetError("conflict", `cleanup_blocked_dirty: ${task.worktreePath}`, "get_task");
    }

    execFileSync("git", ["worktree", "remove", task.worktreePath], {
      cwd: repo.baseCheckout,
      stdio: "ignore"
    });
    execFileSync("git", ["worktree", "prune"], {
      cwd: repo.baseCheckout,
      stdio: "ignore"
    });

    return { cleaned: true };
  }
}
