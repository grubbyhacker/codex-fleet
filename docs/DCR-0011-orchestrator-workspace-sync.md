# DCR-0011: Orchestrator Workspace Sync

## Context

Orchestrators often use a shared project directory, such as `~/src/agent-infra`, as their broad context while coordinating work across several repositories. Those shared checkouts can drift behind `origin/main` quickly when multiple Fleet workers and human-reviewed PRs are active.

Stale context checkouts make orchestrators spend turns rediscovering outdated files, mismatched local state, or already-merged branches. This is not product work in any one repo, but it affects the end-to-end reliability and cost of Fleet-backed orchestration.

## Decision

Codex Fleet should grow an operator workspace hygiene tool for shared orchestrator context checkouts. The initial shape should be a bounded CLI surface, not automatic worker behavior:

- `codex-fleet workspace status`
- `codex-fleet workspace sync --dry-run`
- `codex-fleet workspace sync`

The tool should discover configured workspace roots, inspect git repositories under those roots, and keep clean default-branch checkouts current with their remote default branch using fetch/prune plus fast-forward only.

Safety rules:

- Never reset, stash, switch branches, or discard local changes.
- Skip and report dirty repositories.
- Skip and report repositories not currently on their default branch.
- Use `git worktree prune` only for safe metadata cleanup.
- Optionally report merged local branches, but do not delete ambiguous or unmerged work.
- Produce a compact summary of updated, current, skipped, and failed repositories.

This should remain an operator/admin action. Orchestrators may use a future read-only status view to notice stale context, but sync should require explicit operator authority.

## Consequences

- Orchestrators can start cross-repo work from fresher local context without spending turns on manual `git fetch` and status checks.
- Shared context checkouts stay separate from Fleet task worktrees; repo mutation still belongs in task-owned worktrees.
- The first implementation can be conservative and auditable because it only fast-forwards clean default-branch checkouts.
- This creates a natural later hook for scheduled maintenance or a status-only MCP view, without making ordinary delegated workers responsible for host workspace hygiene.
