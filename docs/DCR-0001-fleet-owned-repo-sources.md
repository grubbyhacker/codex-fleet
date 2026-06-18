# DCR-0001: Fleet-Owned Repo Sources And Shell Workspaces

Status: Accepted
Date: 2026-06-18

## Context

`docs/DESIGN.md` currently treats a configured local checkout as the repo registry source. The daemon uses that checkout as a template and cuts isolated worktrees for repo-mutating tasks. That avoids most collisions, but it still depends on human-managed clone paths existing, staying synchronized, having sane remotes, and not being renamed.

The shell target also runs with host access. Even with prompt guardrails, it can see and mutate any local checkout the operator can access. That makes shell tasks the remaining collision surface: a shell worker can accidentally commit, push, or change branches in the same clone the operator is using.

This is acceptable as a local prototype but not as a public-quality product shape. Public users should not inherit assumptions about one operator's filesystem layout, and Fleet should not depend on a human keeping local clones fresh.

## Decision

Codex Fleet should own its repo sources and shell workspaces.

Repo targets should be configured primarily by remote identity, not by a human checkout path:

```json
{
  "repos": [
    {
      "alias": "youknowme",
      "remoteUrl": "git@github.com:grubbyhacker/youknowme.git",
      "defaultBranch": "main",
      "branchProtected": true,
      "verifyCommands": ["mise exec -- pytest"],
      "defaultModelTier": "standard"
    }
  ]
}
```

The daemon maintains Fleet-owned bare mirrors under `~/.codex-fleet/repos/<alias>.git`. Before creating a task worktree, it fetches the configured default branch into that mirror and creates task worktrees from the mirror into `~/.codex-fleet/worktrees/<alias>/<taskShort>`.

`baseCheckout` remains a transitional local-development compatibility option, but it is no longer the recommended source model. When both `remoteUrl` and `baseCheckout` are present, `remoteUrl` is authoritative for new task worktrees.

Shell targets should start in a Fleet-owned neutral directory, not in the daemon's current working directory or any configured repo checkout. The default should be a per-task scratch directory under `~/.codex-fleet/shell/<taskShort>`, with no repository attached. Shell workers remain for host operations, diagnostics, deploy invocation, SSH, and log inspection. Code changes and git mutation should go through repo targets.

## Consequences

- Renaming or deleting an operator's personal clone no longer breaks Fleet repo tasks.
- Dirty local human worktrees cannot affect task branch creation.
- Public examples can use repo aliases and remote URLs instead of machine-specific absolute paths.
- Fleet becomes responsible for mirror lifecycle: clone/fetch/prune, auth failures, disk usage, and cleanup of stale mirror metadata.
- Repo task startup may pay a first-use clone cost and recurring fetch cost.
- Some workflows that intentionally used shell to mutate real clones must be rerouted to repo targets, or made explicit through a future privileged profile.

## Implementation Sketch

1. Extend repo registry schema with `remoteUrl` and optional `mirrorPath`.
2. Add a `RepoSourceManager` that ensures `~/.codex-fleet/repos/<alias>.git` exists as a bare mirror and fetches the configured default branch.
3. Change worktree creation to use the Fleet-owned mirror when `remoteUrl` is configured.
4. Keep `baseCheckout` support as legacy/development fallback and surface a warning in `list_targets` or operator diagnostics.
5. Add `shellRoot` to Fleet paths and launch shell workers in `~/.codex-fleet/shell/<taskShort>`.
6. Add cleanup for shell scratch directories when a shell task is ended.
7. Update productionization config examples to use `remoteUrl`, not `/Users/...` paths.
8. Add integration tests proving:
   - repo worktree creation succeeds from a remote URL with no local base checkout,
   - dirty/renamed human clones do not affect Fleet worktrees,
   - shell workers receive a Fleet-owned cwd,
   - shell `push_to_main`/repo mutation is rejected or redirected before worker launch if policy enforcement is added.

## Open Questions

- Should `baseCheckout` be removed before public release or kept indefinitely as an expert/local-speed option?
- Should mirrors be bare `--mirror` clones or bare repos with only selected refs fetched?
- Should shell target remain one broad target with a neutral cwd, or split into explicit profiles such as `host_ops`, `deploy`, and `diagnostics`?
- Should the daemon hard-reject shell delivery modes that imply git mutation, or keep that as worker instruction until access profiles exist?
