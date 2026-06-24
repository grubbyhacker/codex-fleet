# codex-fleet

Codex Fleet is a local, single-operator orchestration layer for running multiple Codex workers from one orchestrator session, while keeping durable task state outside the MCP connection.

The core loop is:

1. An orchestrator such as Claude/Cowork connects through the MCP adapter.
2. It calls `initialize` to name the current work session.
3. It delegates repo or shell tasks to the daemon.
4. The daemon starts task-scoped Codex workers, tracks events, owns worktrees/scratch dirs, and preserves final output.
5. The CLI and TUI show what happened and clean up disposable Fleet-owned resources.

This repo implements the v1 shape described in [docs/DESIGN.md](docs/DESIGN.md), plus the accepted design changes in `docs/DCR-*.md`.

## What Exists

- `codex-fleet-daemon`: durable local daemon and Unix-socket RPC server.
- `codex-fleet-mcp`: stateless stdio MCP adapter for orchestrators.
- `codex-fleet`: operator CLI for clients, service setup, task inspection, and cleanup.
- `codex-fleet-tui`: OpenTUI dashboard for live fleet visibility.
- Per-client auth tokens and scopes under `~/.codex-fleet`.
- Repo targets backed by Fleet-owned mirrors or legacy base checkouts.
- Per-task repo worktrees under `~/.codex-fleet/worktrees/<repo>/<taskShort>`.
- Per-task shell scratch dirs under `~/.codex-fleet/shell/<taskShort>`.
- Event/task state durable enough to survive MCP adapter or orchestrator restarts.

## Bootstrap

This repo uses `mise` to pin runtimes and Bun for package management, scripts, tests, and builds.

```sh
mise install
mise exec -- bun install
mise exec -- bun run check
mise exec -- bun run install:bin
```

Installed binaries go to `~/.local/bin`:

```sh
codex-fleet
codex-fleet-daemon
codex-fleet-mcp
codex-fleet-tui
```

When changing TUI behavior, rebuild and install before using it:

```sh
mise exec -- bun run install:bin
```

## State And Clients

Default state lives in `~/.codex-fleet`. Override with `CODEX_FLEET_STATE_DIR` for tests or isolated runs.

Create clients once:

```sh
codex-fleet client init cli --role cli
codex-fleet client init dashboard --role dashboard
codex-fleet client init claudecowork --role orchestrator
```

Roles matter:

- `orchestrator`: delegate, wait, inspect, and end its tasks.
- `dashboard`: read-only task visibility.
- `cli`: operator commands, including cleanup and service management.

## Running The Daemon

Foreground:

```sh
codex-fleet-daemon run
```

macOS LaunchAgent:

```sh
codex-fleet service launch-agent install
codex-fleet service launch-agent load
codex-fleet service launch-agent status
```

Restart after changing installed binaries:

```sh
codex-fleet service launch-agent restart
```

## MCP Adapter

Point an MCP client at:

```sh
~/.local/bin/codex-fleet-mcp
```

Use a client id/token created with the orchestrator role, usually through environment/config:

```sh
CODEX_FLEET_CLIENT_ID=claudecowork
```

The adapter is disposable. It proxies to the daemon; task state stays in the daemon.

## Repo Targets

Repo targets are configured in `~/.codex-fleet/repos.json`.

Preferred remote-backed shape:

```json
{
  "repos": [
    {
      "alias": "vps-ops",
      "remoteUrl": "git@github.com:example/vps-ops.git",
      "defaultBranch": "main",
      "branchProtected": true,
      "verifyCommands": ["mise run check"],
      "defaultModelTier": "strong"
    }
  ]
}
```

Fleet keeps mirrors under `~/.codex-fleet/repos` and creates isolated task worktrees from them. `baseCheckout` still exists as a local-development compatibility option, but remote-backed targets are the intended shape.

There is also a shell target. Shell workers start in Fleet-owned scratch space and are instructed not to mutate shared local checkouts.

## Sessions, Tasks, Workers

These are different concepts:

- Session: the orchestrator work context, e.g. `claudecowork/observability-upgrade`.
- Task: one delegated unit of work.
- Worker: one Codex process executing that task.

For a typical Cowork project, expect one session with several tasks beneath it. Cowork should call `initialize({ sessionName })` early so the TUI can group related workers.

## CLI

Common inspection commands:

```sh
codex-fleet list
codex-fleet status <taskId>
codex-fleet logs <taskId>
codex-fleet watch <taskId>
```

Cleanup:

```sh
codex-fleet cleanup list --dry-run
codex-fleet cleanup run --task <taskId>
codex-fleet cleanup run --task <taskId> --force
codex-fleet cleanup wipe-clean --dry-run
codex-fleet cleanup wipe-clean
```

`wipe-clean` is the local single-operator escape hatch: it removes terminal Fleet-owned repo worktrees, including dirty or ahead-of-base worktrees, and force-deletes Fleet branches when present. It skips live tasks and already-removed worktrees. Durable task records and final responses remain.

## TUI

Run the live dashboard:

```sh
codex-fleet-tui
```

Run with fixture data:

```sh
codex-fleet-tui --demo
```

Render once for debugging:

```sh
codex-fleet-tui --once --demo --no-color
```

Keyboard controls:

- `j` / `k` or arrows: move selection.
- `g` / `G`: first / last visible task.
- `Tab`: cycle detail mode.
- `o`, `p`, `r`, `s`: overview, prompt, result, stderr.
- `x`: wipe clean the Action Queue.
- `q`: quit.

The dashboard shows:

- live, stale, exited, cleanup-pending, and attention counts;
- session-grouped tasks;
- selected task details, retained prompt/result/stderr, and recent events;
- a persistent `CODEX FLEET` logo;
- daily, weekly, and monthly Codex token totals read from the local Codex SQLite state DB.

Token totals are local and best-effort. They are not downloaded and are cached by the TUI for 60 seconds. Demo mode uses fake fixed token values.

## Development

Read [AGENTS.md](AGENTS.md) before agent-driven changes.

Useful commands (run via `mise exec --`):

```sh
mise exec -- bun run typecheck
mise exec -- bun run typecheck:watch
mise exec -- bun run lint
mise exec -- bun run lint:fix
mise exec -- bun run format
mise exec -- bun run format:check
mise exec -- bun run test:unit
mise exec -- bun run test:integration
mise exec -- bun run test:all
mise exec -- bun run test:all-raw
mise exec -- bun run build
mise exec -- bun run test:e2e:codex
mise exec -- bun run test
mise exec -- bun run check
```

Real Codex E2E tests are opt-in because they spend tokens:

```sh
mise exec -- bun run test:e2e:codex
```

Package layout:

- `packages/shared`: Zod schemas, TypeScript types, RPC contracts.
- `packages/daemon`: durable daemon, worker lifecycle, repo/worktree/shell ownership.
- `packages/mcp-adapter`: stateless stdio MCP adapter.
- `packages/cli`: operator CLI.
- `packages/tui`: OpenTUI dashboard.
- `test/integration`: cross-package behavior tests.

`docs/DESIGN.md` is source-of-truth design context and should not be edited by agents. Product/design deviations are recorded as concise DCRs in `docs/`.
