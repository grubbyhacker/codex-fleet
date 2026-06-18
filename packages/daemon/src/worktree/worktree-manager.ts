import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveGitExecutable } from "../git.js";
import type { FleetPaths } from "../paths.js";
import type { RepoConfig } from "../registry/repo-registry.js";
import type { RepoSource } from "../registry/repo-source-manager.js";

export type WorktreeResource = {
  branch?: string;
  worktreePath: string;
};

export class WorktreeManager {
  constructor(private readonly paths: FleetPaths) {}

  create(
    repo: RepoConfig,
    taskId: string,
    source: RepoSource,
    options: { branch: boolean }
  ): WorktreeResource {
    const taskShort = taskId.slice(0, 8);
    const repoWorktreesDir = join(this.paths.worktreesDir, repo.alias);
    mkdirSync(repoWorktreesDir, { mode: 0o700, recursive: true });

    const branch = options.branch ? `fleet/${repo.alias}/${taskShort}` : undefined;
    const worktreePath = join(repoWorktreesDir, taskShort);
    const args = branch
      ? ["worktree", "add", "-b", branch, worktreePath, source.startPoint]
      : ["worktree", "add", "--detach", worktreePath, source.startPoint];
    execFileSync(resolveGitExecutable(), args, {
      cwd: source.ownerPath,
      stdio: "ignore"
    });

    return { branch, worktreePath };
  }
}
