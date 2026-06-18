import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveGitExecutable } from "../git.js";
import type { FleetPaths } from "../paths.js";
import { FleetError } from "../rpc/errors.js";
import type { RepoConfig } from "./repo-registry.js";

export type RepoSource = {
  ownerPath: string;
  startPoint: string;
  kind: "mirror" | "baseCheckout";
};

export class RepoSourceManager {
  constructor(private readonly paths: FleetPaths) {}

  prepare(repo: RepoConfig): RepoSource {
    if (repo.remoteUrl) {
      return this.prepareMirror(repo);
    }
    if (!repo.baseCheckout) {
      throw new FleetError("bad_request", `Repo "${repo.alias}" has no remoteUrl or baseCheckout`);
    }
    return {
      ownerPath: repo.baseCheckout,
      startPoint: resolveFreshDefaultStartPoint(repo),
      kind: "baseCheckout"
    };
  }

  ownerPath(repo: RepoConfig): string {
    if (repo.remoteUrl) {
      return mirrorPath(this.paths, repo);
    }
    if (!repo.baseCheckout) {
      throw new FleetError("bad_request", `Repo "${repo.alias}" has no remoteUrl or baseCheckout`);
    }
    return repo.baseCheckout;
  }

  private prepareMirror(repo: RepoConfig): RepoSource {
    const git = resolveGitExecutable();
    const path = mirrorPath(this.paths, repo);
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    if (!existsSync(path)) {
      execFileSync(git, ["clone", "--bare", repo.remoteUrl ?? "", path], {
        stdio: "ignore"
      });
    } else {
      ensureOriginMatches(path, repo);
    }
    const remoteRef = `refs/remotes/origin/${repo.defaultBranch}`;
    execFileSync(
      git,
      ["fetch", "--prune", "origin", `+refs/heads/${repo.defaultBranch}:${remoteRef}`],
      {
        cwd: path,
        stdio: "ignore"
      }
    );
    return { ownerPath: path, startPoint: remoteRef, kind: "mirror" };
  }
}

export function mirrorPath(paths: FleetPaths, repo: RepoConfig): string {
  return repo.mirrorPath ?? join(paths.reposDir, `${repo.alias}.git`);
}

export function resolveFreshDefaultStartPoint(repo: RepoConfig): string {
  if (!repo.baseCheckout) {
    throw new FleetError("bad_request", `Repo "${repo.alias}" has no baseCheckout`);
  }
  if (!hasOriginRemote(repo.baseCheckout)) {
    return repo.defaultBranch;
  }

  const remoteRef = `refs/remotes/origin/${repo.defaultBranch}`;
  execFileSync(
    resolveGitExecutable(),
    ["fetch", "--prune", "origin", `+refs/heads/${repo.defaultBranch}:${remoteRef}`],
    {
      cwd: repo.baseCheckout,
      stdio: "ignore"
    }
  );
  return remoteRef;
}

function ensureOriginMatches(path: string, repo: RepoConfig): void {
  const git = resolveGitExecutable();
  const current = execFileSync(git, ["remote", "get-url", "origin"], {
    cwd: path,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  if (current !== repo.remoteUrl) {
    throw new FleetError(
      "conflict",
      `Repo mirror for "${repo.alias}" has origin "${current}", expected "${repo.remoteUrl}"`
    );
  }
}

function hasOriginRemote(baseCheckout: string): boolean {
  try {
    execFileSync(resolveGitExecutable(), ["remote", "get-url", "origin"], {
      cwd: baseCheckout,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}
