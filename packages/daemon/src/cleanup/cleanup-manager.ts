import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

import type { TaskSnapshot } from "@codex-fleet/shared";

import type { FleetPaths } from "../paths.js";
import type { RepoConfig } from "../registry/repo-registry.js";
import { mirrorPath } from "../registry/repo-source-manager.js";
import { FleetError } from "../rpc/errors.js";
import { resolveGitExecutable } from "../git.js";

export type CleanupResult = {
  cleaned: boolean;
  branchDeleted?: boolean;
  reason?: string;
};

export class CleanupManager {
  constructor(private readonly paths: FleetPaths) {}

  releaseWorktree(task: TaskSnapshot, repo?: RepoConfig): CleanupResult {
    if (task.shellPath) {
      if (!existsSync(task.shellPath)) {
        return { cleaned: false, reason: "already_removed" };
      }
      rmSync(task.shellPath, { force: true, recursive: true });
      return { cleaned: true };
    }
    if (!task.worktreePath) {
      return { cleaned: false, reason: "no_worktree" };
    }
    if (!repo) {
      return { cleaned: false, reason: "repo_missing" };
    }
    if (!existsSync(task.worktreePath)) {
      return { cleaned: false, reason: "already_removed" };
    }

    const git = resolveGitExecutable();
    const ownerPath = repo.remoteUrl ? mirrorPath(this.paths, repo) : repo.baseCheckout;
    if (!ownerPath) {
      return { cleaned: false, reason: "repo_source_missing" };
    }
    const dirty = execFileSync(git, ["status", "--porcelain"], {
      cwd: task.worktreePath,
      encoding: "utf8"
    }).trim();
    if (dirty.length > 0) {
      throw new FleetError("conflict", `cleanup_blocked_dirty: ${task.worktreePath}`, "get_task");
    }

    execFileSync(git, ["worktree", "remove", task.worktreePath], {
      cwd: ownerPath,
      stdio: "ignore"
    });
    execFileSync(git, ["worktree", "prune"], {
      cwd: ownerPath,
      stdio: "ignore"
    });
    const branchDeleted = task.branch ? deleteBranchIfMerged(ownerPath, task.branch) : false;

    return { cleaned: true, branchDeleted };
  }
}

export function deleteBranchIfMerged(ownerPath: string, branch: string): boolean {
  try {
    execFileSync(resolveGitExecutable(), ["branch", "-d", branch], {
      cwd: ownerPath,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}
