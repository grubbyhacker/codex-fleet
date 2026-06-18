import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { FleetPaths } from "../paths.js";
import type { RepoConfig } from "../registry/repo-registry.js";

export type WorktreeResource = {
  branch: string;
  worktreePath: string;
};

export class WorktreeManager {
  constructor(private readonly paths: FleetPaths) {}

  create(repo: RepoConfig, taskId: string): WorktreeResource {
    const taskShort = taskId.slice(0, 8);
    const repoWorktreesDir = join(this.paths.worktreesDir, repo.alias);
    mkdirSync(repoWorktreesDir, { mode: 0o700, recursive: true });

    const branch = `fleet/${repo.alias}/${taskShort}`;
    const worktreePath = join(repoWorktreesDir, taskShort);
    const startPoint = resolveFreshDefaultStartPoint(repo);
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, startPoint], {
      cwd: repo.baseCheckout,
      stdio: "ignore"
    });

    return { branch, worktreePath };
  }
}

export function resolveFreshDefaultStartPoint(repo: RepoConfig): string {
  if (!hasOriginRemote(repo)) {
    return repo.defaultBranch;
  }

  const remoteRef = `refs/remotes/origin/${repo.defaultBranch}`;
  execFileSync(
    "git",
    ["fetch", "--prune", "origin", `+refs/heads/${repo.defaultBranch}:${remoteRef}`],
    {
      cwd: repo.baseCheckout,
      stdio: "ignore"
    }
  );
  return remoteRef;
}

function hasOriginRemote(repo: RepoConfig): boolean {
  try {
    execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repo.baseCheckout,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}
