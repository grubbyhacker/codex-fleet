# DCR-0006: Dirty Worktree Stop Nudge

Status: Superseded by DCR-0007
Date: 2026-06-29

## Context

`docs/DESIGN.md` treats worker completion as an operational fact: the daemon observes that Codex exited, then reports worktree status to the orchestrator. That remains the right boundary for semantic completion, but recent repo tasks have exited with dirty Fleet worktrees that should usually have been committed, pushed, or converted into a clear blocker before the worker stopped.

Codex supports `Stop` hooks that can block a turn and force the agent to continue. A hook can therefore turn the existing post-run dirty-worktree warning into a bounded pre-stop nudge for delivery modes where a dirty worktree is usually accidental.

## Decision

For repo worktree tasks in `pr_for_review`, `full_delivery`, and `push_to_main`, Fleet installs a daemon-owned Codex `Stop` hook for the worker process. If `git status --porcelain` is dirty, the hook blocks the stop up to two times by default. The hook asks the worker to resolve the dirty worktree or report the exact blocker before stopping.

The hook is generated under Fleet state, not in the delegated repository, and Fleet launches Codex with hook-trust bypass for that worker invocation because the hook source is daemon-owned automation.

After the nudge cap is reached, the hook allows Codex to stop. The existing daemon post-run worktree inspection and final-response attention remain the source of truth for what happened.

## Consequences

- Workers get a concrete chance to fix accidental dirty-worktree exits before the orchestrator has to retry or clean up.
- The nudge is bounded, so a stuck worker cannot loop indefinitely from this hook alone.
- `patch`, `research_only`, and shell targets keep their current behavior because dirty local state can be expected or unrelated there.
- This adds a Codex-specific lifecycle dependency inside the backend implementation without changing the public Fleet API.
