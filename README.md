# codex-fleet

Codex Fleet is a greenfield implementation of the orchestration and observability system described in `docs/DESIGN.md`.

## Bootstrap

This repo uses `mise` to pin runtimes and Bun as the JavaScript package manager and task runner.

```sh
mise install
mise exec -- bun install
mise exec -- bun run spike:bun
mise exec -- bun run check
```

Read `AGENTS.md` before making agent-driven changes.
