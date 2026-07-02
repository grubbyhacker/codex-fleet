# Codex Fleet Agent Notes

## Operating Rules

- `docs/DESIGN.md` is immutable from an agent point of view. Read it as source-of-truth context; do not edit it.
- Decisions may change as implementation teaches us. Any product/design change from `docs/DESIGN.md` must be recorded as a concise Design Change Record in `docs/`.
- Plans, handoffs, command notes, test additions, and implementation sequencing are operational records; they do not require DCRs.
- `../agentchatpoc` is read-only inspiration. Do not modify it, and prefer `docs/DESIGN.md` when the prototype disagrees with the design.
- Keep `docs/` as the home for design documents, DCRs, and future operational docs.
- Keep `agent-handoff.md` concise and high-level. If it exceeds 500 lines, compact old entries automatically before appending new ones.
- Repo-mutating tasks should not end as loose local edits. After implementing and validating, agents should have committed changes on a feature branch, pushed it, opened a normal ready-for-review PR, and reported validation results plus clean task worktree state.
- A ready-for-review PR is the default handoff point. Agents should release their turn there unless the operator explicitly asks for merge, deploy, or post-merge cleanup.
- Do not wait indefinitely on GitHub checks, deploys, or external workflows. For PR handoff, report one concrete check snapshot and stop; if merge/deploy is explicitly requested, use bounded waits and report only material status changes.
- Do not leave validated repo changes only in the local worktree as the final state of a task.
- Never open draft PRs unless the operator explicitly requests draft mode.
- Code review is the human gate: agents must not self-merge unless explicitly directed to do so.
- PR completion should be reconciled from durable artifacts (branch/worktree state, task/workflow results, CI checks) and not from worker prose alone.
- After opening a ready-for-review PR, agents should stop with a clean task worktree and report branch, PR, validation, and any material CI snapshot. Post-merge local branch and worktree cleanup is fleet maintenance work, handled by GitHub remote branch auto-deletion, daemon/CLI cleanup, or an explicit operator request.
- Agents should only perform post-merge cleanup inline when the operator explicitly asks for it, when merge/deploy/post-merge cleanup was part of the original task, or when stale local state blocks the current work. In those cases, use bounded cleanup steps and report any dirty files or ambiguity instead of forcing deletion.
- If an agent cannot produce a ready PR, it must report the exact dirty files and the blocking reason, not silently leave the tree dirty.
- Before claiming completion, run at least one sanity validation for docs-only changes (or a brief note that fuller checks were intentionally skipped); full checks should be reported explicitly when omitted.

## Runtime And Tooling

- `mise` owns runtime bootstrapping. Run `mise install` before repo work.
- Bun is pinned in `mise.toml` and is the JavaScript domain tool for dependency management, scripts, tests, and lockfile generation.
- Do not rely on an ambient `bun` from the shell. Use `mise exec -- bun ...` in automation and handoffs.
- If Node becomes necessary for daemon or adapter work, pin it in `mise.toml` and add a DCR only if the fallback changes the design intent in `docs/DESIGN.md`.

## Current Commands

- Install dependencies: `mise exec -- bun install`
- Runtime spike: `mise exec -- bun run spike:bun`
- Typecheck: `mise exec -- bun run typecheck`
- Lint: `mise exec -- bun run lint`
- Format check: `mise exec -- bun run format:check`
- Tests: `mise exec -- bun test`
- Full check: `mise exec -- bun run check`

## Repo Shape

- `packages/shared` holds shared Zod schemas, TypeScript types, and RPC contracts.
- `packages/daemon` will hold the durable daemon.
- `packages/mcp-adapter` will hold the stateless stdio MCP adapter.
- `packages/cli` will hold operator CLI commands.
- `packages/tui` will hold the read-only OpenTUI dashboard when that phase starts.
- `test/schema` and `test/integration` hold cross-package tests.
