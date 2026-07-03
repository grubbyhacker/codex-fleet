# codex-fleet Productionization Plan

Status: ready to implement - Date: 2026-06-18

This is an operational rollout plan, not a design change record. `docs/DESIGN.md` remains the source of truth for product/design intent.

## Goal

Move codex-fleet v1 from a source-run development setup to the real personal production setup:

- Run named codex-fleet binaries instead of `bun run ...` for daemon and MCP use.
- Keep the old POC available as `codex-fleet-poc`.
- Make v1 the official `codex-fleet` MCP server for Codex Desktop and Claude/Cowork.
- Register the real `agent-infra` repos as v1 targets.
- Use v1 for real work and fix issues as they appear.

## Current State

- v1 implementation is complete and checked in.
- Codex Desktop has:
  - `codex-fleet` pointing at v1 source-run MCP adapter.
  - `codex-fleet-poc` pointing at the old POC.
- Claude/Cowork still has the old POC registered as `codex-fleet`.
- LaunchAgent currently runs the v1 daemon, but the service shape still needs to move to named binaries.
- The daemon can spawn Codex workers when `CODEX_FLEET_CODEX_COMMAND=/Applications/Codex.app/Contents/Resources/codex` is set.
- Bun macOS privacy prompts were caused by running the service through Bun; owner has removed accidental Bun permissions.

## Production Binary Shape

Build and install standalone executables:

- `~/.local/bin/codex-fleet`
- `~/.local/bin/codex-fleet-daemon`
- `~/.local/bin/codex-fleet-mcp`
- `~/.local/bin/codex-fleet-tui`

Implementation requirements:

- Use repo-pinned Bun via `mise exec -- bun build --compile`.
- Build outputs to `dist/bin/`.
- Install copies to `~/.local/bin` with executable permissions.
- Add root scripts:
  - `build:bin`
  - `install:bin`
- Keep source-mode commands for development and tests.
- Production LaunchAgent and MCP registrations must use installed binaries only.

## LaunchAgent Shape

Update LaunchAgent generation to run:

```text
~/.local/bin/codex-fleet-daemon run
```

Do not run:

```text
bun run packages/cli/src/index.ts daemon run
```

Required environment:

```text
CODEX_FLEET_WORKER_BACKEND=codex
CODEX_FLEET_CODEX_COMMAND=/Applications/Codex.app/Contents/Resources/codex
```

Do not set `CODEX_FLEET_CODEX_MODEL` by default. Let Codex use the operator's
configured default model unless a worker model is intentionally pinned for a
specific experiment.

Add or complete practical service commands:

```sh
codex-fleet service launch-agent install
codex-fleet service launch-agent load
codex-fleet service launch-agent unload
codex-fleet service launch-agent restart
codex-fleet service launch-agent status
```

Acceptance:

- launchd reports `state = running`.
- ProgramArguments point at `~/.local/bin/codex-fleet-daemon`.
- No `bun run` in the plist.
- Daemon socket responds through CLI.
- New macOS privacy prompts, if any, are attributed to codex-fleet binaries, not Bun.

## MCP Migration

Codex Desktop:

- Keep old POC as `codex-fleet-poc`.
- Use v1 as official `codex-fleet`.
- Change v1 command to `~/.local/bin/codex-fleet-mcp`.
- Keep client id `codex`.

Claude/Cowork:

- Rename existing POC `codex-fleet` to `codex-fleet-poc`.
- Add v1 as official `codex-fleet`.
- Use command `~/.local/bin/codex-fleet-mcp`.
- Create/use client id `claudecowork`.

Do not delete the POC yet. Retire it only after v1 has handled real multi-repo work.

## Repo Registry

Target public-safe shape for `~/.codex-fleet/repos.json`:

```json
{
  "repos": [
    {
      "alias": "vps-ops",
      "remoteUrl": "git@github.com:grubbyhacker/vps-ops.git",
      "defaultBranch": "main",
      "branchProtected": false,
      "verifyCommands": [
        "ansible-playbook -i inventory/local.yml playbooks/site.yml --syntax-check",
        "ansible-playbook -i inventory/production.yml playbooks/site.yml --syntax-check"
      ],
      "defaultModelTier": "strong"
    },
    {
      "alias": "youknowme",
      "remoteUrl": "git@github.com:grubbyhacker/youknowme.git",
      "defaultBranch": "main",
      "branchProtected": true,
      "verifyCommands": ["mise run lint", "mise run test"],
      "defaultModelTier": "strong"
    },
    {
      "alias": "gh-agent-broker",
      "remoteUrl": "git@github.com:grubbyhacker/gh-agent-broker.git",
      "defaultBranch": "main",
      "branchProtected": true,
      "verifyCommands": ["make check"],
      "defaultModelTier": "strong"
    },
    {
      "alias": "ykmcorpus",
      "remoteUrl": "git@github.com:grubbyhacker/ykmcorpus.git",
      "defaultBranch": "main",
      "branchProtected": true,
      "verifyCommands": ["mise run validate"],
      "defaultModelTier": "strong"
    }
  ]
}
```

Current implementation note:

- `remoteUrl` is the preferred schema and uses Fleet-owned mirrors under `~/.codex-fleet/repos`.
- `baseCheckout` remains a compatibility option for private/local development configs during migration.

## Verification

Local checks:

```sh
mise exec -- bun run check
mise exec -- bun run build:bin
~/.local/bin/codex-fleet --probe
~/.local/bin/codex-fleet-mcp --probe
~/.local/bin/codex-fleet-tui --probe
```

Service checks:

```sh
codex-fleet service launch-agent restart
codex-fleet service launch-agent status
CODEX_FLEET_CLIENT_ID=cli codex-fleet list
```

Codex Desktop smoke:

- `codex-fleet` initializes a session.
- `list_targets` shows shell plus four repo targets.
- One shell `research_only` task exits successfully.
- One repo `research_only` task exits successfully.

Claude/Cowork smoke:

- Same flow using official `codex-fleet`.
- Confirm old POC is reachable only as `codex-fleet-poc`.

Real-use readiness:

- TUI shows active tasks.
- CLI `list`, `status`, `logs`, and `cleanup list --dry-run` work.
- A repo task creates an isolated worktree and leaves base checkout untouched.
- Clean repo task cleanup removes worktree and safe branch.

## Assumptions

- This is a personal tool for one operator; rollout can be pragmatic.
- `~/.codex-fleet` remains the production state dir.
- `codex-fleet` is the official v1 MCP name everywhere.
- `codex-fleet-poc` is the preserved fallback name.
- Do not pin an initial worker model in service config; model pins are explicit overrides.
- Production-impacting work may begin after service, registry, and client smoke tests pass; issues found during real use should be fixed in v1 rather than blocking rollout indefinitely.
