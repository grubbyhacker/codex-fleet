# codex-fleet

Codex Fleet is a local, single-operator orchestration layer for running multiple Codex workers from one orchestrator session while keeping durable task state outside the MCP connection.

## What it gives you

- durable local daemon + authenticated socket (`codex-fleet-daemon`)
- stateless MCP adapter (`codex-fleet-mcp`) for orchestrators
- operator CLI (`codex-fleet`) for inspection, service control, and cleanup
- read-only OpenTUI dashboard (`codex-fleet-tui`) for live visibility
- repo and shell task targeting with Fleet-owned task workspaces and retention

## Product semantics

The product behavior is described in [docs/DESIGN.md](docs/DESIGN.md).

1. Orchestrator connects through MCP.
2. Client initializes a session.
3. Work is delegated as repo or shell tasks.
4. Daemon launches per-task workers, tracks lifecycle/events, and stores durable outputs.
5. CLI/TUI read task status from daemon-owned state.

Session, task, and worker are separate concepts:

- Session: orchestrator work context (e.g. `claudecowork/observability-upgrade`).
- Task: one delegated unit.
- Worker: one Codex process executing that unit.

### Readme-backed architecture walkthrough

A dedicated walkthrough artifact is available here:

- [docs/CODE_WALKTHROUGH.md](docs/CODE_WALKTHROUGH.md)

## Workstation deployment plumbing

### Prerequisites

- [`mise`](https://mise.jdx.dev/) and pinned Bun via `mise install`.
- A usable `codex` binary for real execution (`CODEX_FLEET_CODEX_COMMAND` may override).
- Git and required tooling for target repositories.

### Bootstrap and install

```sh
mise install
mise exec -- bun install
mise exec -- bun run build:bin
mise exec -- bun run install:bin
```

Installed binaries are placed under `~/.local/bin`:

- `codex-fleet`
- `codex-fleet-daemon`
- `codex-fleet-mcp`
- `codex-fleet-tui`

### Clients and roles

```sh
codex-fleet client init cli --role cli
codex-fleet client init dashboard --role dashboard
codex-fleet client init claudecowork --role orchestrator
```

Role summary:

- `orchestrator`: delegate, wait, inspect, and end tasks
- `dashboard`: read-only visibility
- `cli`: operator commands including cleanup/service actions

### Daemon and MCP

Start daemon:

```sh
codex-fleet daemon run
```

Mac launchd flow:

```sh
codex-fleet service launch-agent install
codex-fleet service launch-agent load
codex-fleet service launch-agent status
```

Optional restart after binary updates:

```sh
codex-fleet service launch-agent restart
```

Point MCP clients at:

```sh
~/.local/bin/codex-fleet-mcp
```

Set context:

```sh
CODEX_FLEET_CLIENT_ID=claudecowork
# optional:
CODEX_FLEET_TOKEN=<token-from-client-init>
```

MCP calls include:

- `initialize`
- `list_targets`
- `delegate_task`
- `get_task`
- `wait_tasks`
- `list_tasks`
- `get_task_history`
- `end_task`

### Runtime targets

Repo targets are configured in `~/.codex-fleet/repos.json` with remote aliases.

```json
{
  "repos": [
    {
      "alias": "youknowme",
      "remoteUrl": "git@github.com:example/youknowme.git",
      "defaultBranch": "main",
      "branchProtected": true,
      "verifyCommands": ["mise run lint", "mise run test"],
      "defaultModelTier": "strong"
    }
  ]
}
```

For each repo task, Fleet manages:

- `~/.codex-fleet/repos/<alias>.git` mirror
- task worktree: `~/.codex-fleet/worktrees/<alias>/<taskShort>`

Shell tasks use `~/.codex-fleet/shell/<taskShort>`.

`baseCheckout` is compatibility mode; remote-backed mirrors/worktrees are the standard shape.

## CLI and TUI usage

Common CLI commands:

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

TUI:

```sh
codex-fleet-tui
codex-fleet-tui --demo
codex-fleet-tui --once --demo --no-color
```

Keyboard controls:

- `j` / `k` or arrows: move selection
- `g` / `G`: first / last visible task
- `Tab`: cycle detail mode
- `o`, `p`, `r`, `s`: overview, prompt, result, stderr
- `x`: wipe action queue
- `q`: quit

## Safety boundaries

- `~/.codex-fleet` is local state and local-only by default.
- Shell workers have host access; keep boundaries explicit for untrusted environments.
- Cleanup removes Fleet-owned worktrees/branches, not durable task records.
- `wipe-clean` is intentionally destructive to disposable local resources only.

## Validation and checks

Preferred command for repository readiness:

```sh
mise exec -- bun run check
```

For targeted workflows:

```sh
mise exec -- bun run typecheck
mise exec -- bun run lint
mise exec -- bun run format:check
mise exec -- bun test
```

Optional Codex-driven integration test:

```sh
mise exec -- bun run test:e2e:codex
```

## Docs and development references

- `docs/DESIGN.md`: source-of-truth design context
- `docs/public-readiness/`: readiness slices and evidence artifacts
- `docs/CODE_WALKTHROUGH.md`: implementation walkthrough and boundaries
- [AGENTS.md](AGENTS.md): agent operation constraints
