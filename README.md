# codex-fleet

Codex Fleet is a local, single-operator orchestration layer for running multiple Codex workers from one orchestrator session (for example Claude/Cowork), while keeping task state, logs, and resources durable outside the MCP process.

What it gives you:

- One durable local daemon + authenticated socket (`codex-fleet-daemon`).
- A stateless MCP adapter (`codex-fleet-mcp`) that keeps orchestrators simple.
- A CLI for operators (`codex-fleet`) and a TUI dashboard (`codex-fleet-tui`).
- Repo and shell task targeting with per-task worktrees and cleanup workflows.

The public behavior contract is in [docs/DESIGN.md](docs/DESIGN.md). This repository does not expose a hosted API; everything is local-first and workspace-local by default.

## Public-reader quickstart

### 1) Prerequisites

Required:

- [`mise`](https://mise.jdx.dev/) and the project-pinned Bun toolchain (managed via `mise`).
- A working `codex` binary for real execution (`CODEX_FLEET_CODEX_COMMAND` can be set to your preferred path).

Recommended:

- macOS for launchd flow (`service launch-agent`), or launch daemon manually if you prefer another process supervisor.
- Git and repo tooling available to the worker process.

Runtime assumptions:

- State and sockets default to `~/.codex-fleet` unless `CODEX_FLEET_STATE_DIR` is set.
- This is single-operator by design (local workspace ownership assumptions, broad shell access for shell workers, local token files, local log/state retention).
- Workers currently run with host-local access; this is intentional, and safe-for-multi-user is not yet assumed.

### 2) Bootstrap and install

```sh
mise install
mise exec -- bun install
mise exec -- bun run build:bin
mise exec -- bun run install:bin
```

Binaries install to `~/.local/bin`:

- `codex-fleet`
- `codex-fleet-daemon`
- `codex-fleet-mcp`
- `codex-fleet-tui`

### 3) Configure clients (auth + role)

```sh
codex-fleet client init cli --role cli
codex-fleet client init dashboard --role dashboard
codex-fleet client init claudecowork --role orchestrator
```

- `cli`: operator commands such as `list`, `status`, `logs`, and cleanup actions.
- `dashboard`: read-only visibility helpers.
- `orchestrator`: MCP-facing role for `initialize`, delegation, and task monitoring.

### 4) Run the daemon

Foreground:

```sh
codex-fleet daemon run
```

Managed service (macOS):

```sh
codex-fleet service launch-agent install
codex-fleet service launch-agent load
codex-fleet service launch-agent status
```

Optional restart after binary upgrades:

```sh
codex-fleet service launch-agent restart
```

### 5) Use the MCP adapter

Point your MCP client at the installed adapter binary:

```sh
~/.local/bin/codex-fleet-mcp
```

Set orchestrator identity in environment:

```sh
CODEX_FLEET_CLIENT_ID=claudecowork
```

If needed:

```sh
CODEX_FLEET_TOKEN=<token-from-client-init>
```

The MCP tool surface is:

- `initialize`
- `list_targets`
- `delegate_task`
- `get_task`
- `wait_tasks`
- `list_tasks`
- `get_task_history`
- `end_task`

### 6) Repo and shell targets

Repo targets are defined in `~/.codex-fleet/repos.json` using aliases and `remoteUrl` entries:

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
  ]
}
```

For each repo task, Fleet creates and owns:

- `~/.codex-fleet/repos/<alias>.git` mirror
- task-specific worktree under `~/.codex-fleet/worktrees/<alias>/<taskShort>`

Shell targets run in Fleet-owned scratch directories such as `~/.codex-fleet/shell/<taskShort>` and do not use repo worktrees by default.

`baseCheckout` is a compatibility configuration mode and is no longer the standard runtime shape.

### 7) CLI + TUI usage

Common CLI commands:

```sh
codex-fleet list
codex-fleet status <taskId>
codex-fleet logs <taskId>
codex-fleet watch <taskId>
codex-fleet cleanup list --dry-run
codex-fleet cleanup run --task <taskId> [--dry-run] [--force]
codex-fleet cleanup wipe-clean --dry-run
codex-fleet cleanup wipe-clean
```

TUI:

```sh
codex-fleet-tui
codex-fleet-tui --demo
```

TUI `--demo` is for local visualization only and does not show live local task state.

### 8) Safety boundaries and local/private behavior

- `~/.codex-fleet` is local state, logs, task files, sockets, auth tokens, and worktrees. It is not synced or shared by default.
- Client token files and critical daemon-owned dirs are local-only artifacts for this machine.
- Shell tasks have broad host access and can execute shell operations. If your workspace hosts untrusted code, run with explicit human review and cleanup discipline.
- Repo tasks are run in Fleet-owned worktrees and branches. Manual operator checkouts are not intended workspaces.
- Existing durable task logs and outputs are retained even after cleanup; cleanup removes worktrees/branches, not durable records.
- Wipe-clean is intentionally destructive and designed for local convenience; it force-removes terminal worktrees and branches.

### 9) Local validation checklist

After installation:

1. Run binary probes:

```sh
~/.local/bin/codex-fleet --probe
~/.local/bin/codex-fleet-daemon --probe
~/.local/bin/codex-fleet-mcp --probe
~/.local/bin/codex-fleet-tui --probe
```

2. Start and validate daemon startup:

```sh
codex-fleet daemon run
```

In another terminal:

```sh
CODEX_FLEET_CLIENT_ID=cli codex-fleet list
```

3. Validate repo plumbing:

```sh
codex-fleet client init claudecowork --role orchestrator
~/.local/bin/codex-fleet-mcp --probe
```

4. Validate UI:

```sh
codex-fleet-tui --once --demo --no-color
```

5. Validate cleanup contract:

```sh
codex-fleet cleanup list --dry-run
```

## Validation and checks

- Runtime/style/type/runtime checks: `mise exec -- bun run check`
- If you change docs only, prefer `mise exec -- bun run check` plus manual review for usage accuracy.

## Internal / design docs

- `docs/DESIGN.md` is the product/design source-of-truth.
- Operational slices, plans, and historical changes live in `docs/`.
- If this repo adds a dedicated non-PRD architecture walkthrough in the future, link it from here as `docs/CODE_WALKTHROUGH.md` (currently not present).

## Development

```sh
mise exec -- bun run typecheck
mise exec -- bun run lint
mise exec -- bun run format:check
mise exec -- bun test
```

Real Codex integration tests are opt-in:

```sh
mise exec -- bun run test:e2e:codex
```
