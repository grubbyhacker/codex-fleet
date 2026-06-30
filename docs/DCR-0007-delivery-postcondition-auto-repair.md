# DCR-0007: Delivery Postcondition Auto-Repair

Status: Accepted
Date: 2026-06-29

## Context

DCR-0006 introduced Codex `Stop` hooks to nudge workers before they ended with dirty delivery worktrees. Local Fleet incidents and direct experiments showed that hooks can work under `codex exec`, but Fleet's `codex mcp-server` worker path does not reliably execute those lifecycle hooks.

Fleet already owns the authoritative post-run worktree inspection, so delivery-contract enforcement belongs in the daemon rather than in orchestrator retry logic or Codex hook behavior.

## Decision

For Fleet-owned repo worktrees in `pr_for_review`, `full_delivery`, and `push_to_main`, the daemon may automatically resume the same task after worker return when postconditions fail. The retry is bounded to two attempts by default and uses the same task id, worktree, and Codex thread when available.

The repair prompt must explain the failed postcondition, preserve intended changes, and ask the worker to reconcile the repository delivery contract. Fleet never auto-stashes, resets, deletes, or otherwise cleans the worktree. If repair attempts are exhausted, Fleet reports the blocker and preserves the dirty state for orchestrator follow-up.

Codex Stop hooks remain best-effort defense-in-depth, but daemon postconditions are the source of truth.

## Consequences

- Orchestrators should see fewer false terminal successes for dirty repo delivery work.
- Repair attempts remain bounded and auditable in task history.
- Existing public Fleet tools and task states do not change.
- `patch`, `research_only`, and shell targets keep their existing dirty-state semantics.
