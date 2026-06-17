# Codex Fleet Agent Notes

## Operating Rules

- `docs/DESIGN.md` is immutable from an agent point of view. Read it as source-of-truth context; do not edit it.
- Decisions may change as implementation teaches us. Any product/design change from `docs/DESIGN.md` must be recorded as a concise Design Change Record in `docs/`.
- Plans, handoffs, command notes, test additions, and implementation sequencing are operational records; they do not require DCRs.
- `../agentchatpoc` is read-only inspiration. Do not modify it, and prefer `docs/DESIGN.md` when the prototype disagrees with the design.
- Keep `docs/` as the home for design documents, DCRs, and future operational docs.
- Keep `agent-handoff.md` concise and high-level. If it exceeds 500 lines, compact old entries automatically before appending new ones.

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
