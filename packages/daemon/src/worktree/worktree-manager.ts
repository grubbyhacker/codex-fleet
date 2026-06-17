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
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, repo.defaultBranch], {
      cwd: repo.baseCheckout,
      stdio: "ignore"
    });

    return { branch, worktreePath };
  }
}
