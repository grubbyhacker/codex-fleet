# DCR-0004: Wipe Clean Action Queue

Status: Accepted
Date: 2026-06-19

## Context

`docs/DESIGN.md` treats the TUI as read-only and cleanup as cautious: dirty worktrees block ordinary cleanup so the operator can inspect possible uncommitted work.

In local single-operator use, that caution creates recurring administration work. Fleet worktrees are disposable scratch owned by Codex Fleet. If no active orchestrator is tracking a terminal task, unmerged or dirty local work in that worktree is not product state from the operator's point of view.

## Decision

Add a `wipe-clean` operation for the Action Queue.

The CLI exposes `codex-fleet cleanup wipe-clean [--dry-run]`. The TUI exposes the same operation with `x`, rendered as `OPS: x wipe clean action queue`.

`wipe-clean` targets terminal tasks with Fleet-owned repo worktrees. It skips live tasks and already-removed worktrees. For remaining targets, it removes the worktree with force and force-deletes the Fleet branch when present.

## Consequences

- The common answer to a stale Action Queue becomes one keypress.
- Dirty or ahead-of-base Fleet worktrees are discarded by design.
- Durable task records, final responses, and event history remain in the daemon store.
- This is appropriate for local single-operator Fleet use; future multi-user or shared deployments should revisit the default and likely require confirmation, ownership checks, or role-specific policy.
