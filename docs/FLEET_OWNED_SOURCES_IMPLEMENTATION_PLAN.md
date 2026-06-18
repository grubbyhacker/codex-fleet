# Fleet-Owned Sources Implementation Plan

Status: Implemented for initial `remoteUrl` mirrors and shell scratch workspaces
Date: 2026-06-18
Related: `DCR-0001-fleet-owned-repo-sources.md`

## Goal

Remove Codex Fleet's operational dependency on human-managed local repo clones and keep shell workers out of user workspaces by default.

## Target Shape

- Repo registry entries prefer `remoteUrl`.
- Fleet mirrors repos under `~/.codex-fleet/repos/<alias>.git`.
- Repo task worktrees are created from Fleet-owned mirrors under `~/.codex-fleet/worktrees/<alias>/<taskShort>`.
- Shell task workers start in Fleet-owned scratch directories under `~/.codex-fleet/shell/<taskShort>`.
- `baseCheckout` remains accepted during migration but is not used when `remoteUrl` is present.

## Phase 1: Schema And Paths

- Extend repo config schema with:
  - `remoteUrl: string`
  - `mirrorPath?: string`
  - `baseCheckout?: string` as legacy fallback instead of required field
- Add `reposDir` and `shellDir` to `FleetPaths`.
- Ensure startup hardening creates `reposDir`, `worktreesDir`, and `shellDir` with `0700`.
- Update `~/.codex-fleet/repos.json` docs/examples to use `remoteUrl`.

## Phase 2: Mirror Manager

- Add `RepoSourceManager`.
- For `remoteUrl` repos:
  - create `~/.codex-fleet/repos/<alias>.git` as a bare repo if missing,
  - configure or verify `origin` equals `remoteUrl`,
  - fetch `+refs/heads/<defaultBranch>:refs/remotes/origin/<defaultBranch>` with prune,
  - return `refs/remotes/origin/<defaultBranch>` as the worktree start point.
- For legacy `baseCheckout` repos:
  - keep current behavior,
  - emit an operator-visible warning event or diagnostic.

## Phase 3: Worktree Creation

- Change `WorktreeManager.create()` to accept a source descriptor from `RepoSourceManager`.
- Use `git -C <mirrorPath> worktree add -b <branch> <worktreePath> <startPoint>` for mirror-backed repos.
- Keep post-run inspection comparing against the fetched remote default ref.
- Ensure cleanup removes worktrees from the same Git repository that owns them, whether mirror-backed or legacy checkout-backed.

## Phase 4: Shell Scratch Workspaces

- Add shell resource allocation for shell tasks:
  - path `~/.codex-fleet/shell/<taskShort>`,
  - create before worker launch,
  - pass as worker cwd for shell tasks,
  - record it as a task resource distinct from repo worktrees.
- Update cleanup/end-task to remove clean shell scratch directories.
- Keep shell worker instructions saying shared checkouts are read-only.

## Phase 5: Policy And UX

- Decide whether to hard-reject shell `push_to_main`.
- Consider rejecting shell `patch`/`pr_for_review` outright unless a future profile explicitly allows host file mutation.
- Add CLI diagnostics:
  - mirror path,
  - last fetch result,
  - remote URL mismatch,
  - legacy `baseCheckout` usage.
- Add migration helper to convert existing `baseCheckout` entries to `remoteUrl` when `origin` exists.

## Tests

- Registry accepts `remoteUrl` without `baseCheckout`.
- Mirror is created on first repo task and reused on subsequent tasks.
- Worktree creation works when the user's human clone is missing or dirty.
- Existing legacy `baseCheckout` tests still pass.
- Shell task worker cwd is under `~/.codex-fleet/shell`.
- `end_task` removes clean shell scratch resources.
- Cleanup removes mirror-backed worktrees and safely deletes merged task branches.

## Migration Notes

Existing private operator config can keep `baseCheckout` during migration. Public examples should use `remoteUrl`.

For Roger's current repos, likely `remoteUrl` values are discoverable from the existing checkouts' `origin` remotes, but the implementation must not depend on `/Users/roger/src/agent-infra`.
