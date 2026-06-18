# Agent Handoff

Keep this file concise and high-level. If it grows beyond 500 lines, compact older entries before appending new work.

## 2026-06-17 Bootstrap

### About To Do

- Bootstrap the repo as a Bun-first, `mise`-pinned TypeScript monorepo.
- Add shared schemas, package skeletons, quality gates, a Bun runtime spike, `AGENTS.md`, and DCR documentation.
- Verify with `mise`, Bun install, spike, typecheck, lint, format check, and tests where possible.

### Did

- Added `mise.toml` pinning Bun 1.3.14 and trusted/installed it locally through `mise`.
- Added Bun workspace tooling, shared schemas, package skeletons, a runtime spike, and schema tests.
- Added `AGENTS.md`, `.prettierignore` for immutable `docs/DESIGN.md`, and DCR-0001 for the repo-local handoff decision.
- Verified `spike:bun`, `typecheck`, `lint`, `format:check`, `bun test`, and aggregate `check`.

## 2026-06-17 V1 Plan

### About To Do

- Store the v1 implementation backlog and sequencing in `docs/V1_IMPLEMENTATION_PLAN.md`.
- Correct DCR guidance so DCRs are only for product/design changes, not operational repo practices.

### Did

- Added `docs/V1_IMPLEMENTATION_PLAN.md` with the v1 backlog, sequencing, verification, sparse Codex E2E approach, and sub-agent parallelism notes.
- Removed the operational handoff DCR and clarified in `AGENTS.md` that DCRs are only for product/design changes.
- Verified `format:check`, aggregate `check`, and no diff to `docs/DESIGN.md`.
- Updated the plan to call for periodic, logical commits at reviewable implementation boundaries.

## 2026-06-17 V1 Implementation

### About To Do

- Continue from the v1 plan without stopping for implementation-level decisions.
- Build reviewable slices with commits and keep paid Codex E2E opt-in only.

### Did

- Implemented the Phase 1 secure daemon RPC slice: scoped token auth, audit JSONL, durable event replay, fake worker, and stateless MCP adapter proxy.
- Added repo registry, task worktree creation, worker backend seam, bounded waits, stale detection, cleanup-on-`end_task`, and read-only CLI views.
- Added opt-in real Codex worker backend and `test:e2e:codex`; normal checks skip paid E2E.
- Added model-tier routing records for requested vs actual tier with safe upgrades.
- Created logical commits for each verified slice.

## 2026-06-18 Async Worker Lifecycle

### Did

- Changed `delegate_task` to return `{taskId}` after recording task creation/running state, then complete the Worker in the background.
- Added deterministic fake-worker delay coverage proving `delegate_task` does not wait for Worker completion.
- Updated the opt-in Codex E2E path to observe completion through `wait_tasks`.
- Verified focused RPC/E2E tests and aggregate `mise exec -- bun run check`.

### Next

- Continue v1 gaps from the plan: richer operator cleanup CLI, TUI observability, and hardening/service install.

## 2026-06-18 Operator Cleanup CLI

### Did

- Let `admin`-scoped CLI clients view, watch, inspect, and end tasks across orchestrator client ownership boundaries.
- Added `codex-fleet cleanup list --dry-run` with worktree candidate classification.
- Added `codex-fleet cleanup run --task <id>` plus explicit `--force` worktree removal for dirty operator cleanup.
- Verified focused CLI/cleanup/RPC tests and aggregate `mise exec -- bun run check`.

### Next

- Continue with v1 observability TUI and daemon hardening/service install items.

## 2026-06-18 OpenTUI Dashboard

### Did

- Added OpenTUI to `packages/tui` and replaced the probe stub with a daemon-backed read-only dashboard.
- Dashboard renders summary counts, usage counters, session groups, task detail, and recent event history.
- Added `codex-fleet-tui --once` and `--once --json` for deterministic render checks.
- Let read-only dashboard clients see fleet-wide task state without gaining mutation scopes.
- Verified focused TUI tests and aggregate `mise exec -- bun run check`.

### Next

- Continue with daemon startup hardening, LaunchAgent install support, and remaining model-routing hardening.

## 2026-06-18 Startup Hardening And LaunchAgent

### Did

- Moved root refusal and socket hardening into daemon startup, including active-socket refusal and stale socket cleanup.
- Added startup coverage for active daemon sockets and stale socket-path leftovers.
- Added `codex-fleet service launch-agent print|install|uninstall` for macOS LaunchAgent plist management.
- Verified focused hardening/CLI tests and aggregate `mise exec -- bun run check`.

### Next

- Continue remaining v1 hardening around model-tier availability/fallback and any final design-plan gaps.

## 2026-06-18 Model Tier Availability

### Did

- Added available-tier routing via `CODEX_FLEET_AVAILABLE_MODEL_TIERS`.
- Kept safety upgrades for high-risk/full-delivery/push-to-main tasks and reject them if no strong tier is available.
- Added explicit `model_routing` events for safety upgrades and unavailable-tier fallbacks.
- Moved routing before worktree creation so rejected repo tasks do not leave orphan worktrees.
- Verified focused model/worktree/RPC tests and aggregate `mise exec -- bun run check`.

### Next

- Do a final v1 gap pass against `docs/DESIGN.md` and `docs/V1_IMPLEMENTATION_PLAN.md`.

## 2026-06-18 Resume And Wait Semantics

### Did

- Added durable `codexThreadId` to task snapshots and replayed state.
- Made Codex workers call `codex-reply` with the existing thread id when resuming.
- Made `delegate_task` with `resumeTaskId` reuse the original task id, worktree, branch, and thread.
- Implemented `wait_tasks.returnOnStatuses` short-circuiting.
- Verified focused RPC/schema/event-store tests and aggregate `mise exec -- bun run check`.

### Next

- Continue final v1 gap pass, especially sparse E2E coverage shape and any remaining operational edge cases.

## 2026-06-18 Sparse E2E Coverage Shape

### Did

- Added fake in-flight adapter restart coverage proving daemon state survives adapter replacement.
- Expanded opt-in real-Codex E2E with model preflight and a tiny repo-patch worktree scenario.
- Kept normal `mise exec -- bun run check` non-paid; real Codex E2E remains skipped unless explicitly enabled.
- Verified focused adapter/E2E-skipped tests and aggregate `mise exec -- bun run check`.

### Next

- Final pass for any remaining v1 gaps; paid Codex E2E has not been run in this slice.

## 2026-06-18 Sparse E2E Verification

### Did

- Fixed the opt-in E2E harness to use Node-compatible process spawning and longer per-test timeouts.
- Ran `CODEX_FLEET_RUN_CODEX_E2E=1 CODEX_FLEET_E2E_MODEL=gpt-5.3-codex-spark mise exec -- bun run test:e2e:codex`; all 3 sparse real-Codex tests passed.
- Re-ran aggregate `mise exec -- bun run check`; normal checks remain green and skip paid E2E.

### Next

- Final status pass and close v1 if no remaining plan/design gaps require implementation.

## 2026-06-18 Productionization Plan

### Did

- Captured the production binary/service/MCP migration plan in `docs/PRODUCTIONIZATION_PLAN.md`.
- Plan covers named binaries, LaunchAgent away from Bun, Codex and Claude/Cowork MCP migration, real `agent-infra` repo registry, and smoke/real-use readiness checks.

### Next

- Implement `docs/PRODUCTIONIZATION_PLAN.md` without editing `docs/DESIGN.md` unless a true design change is discovered.

## 2026-06-18 Cleanup Branch Retention

### Did

- Added safe branch deletion after worktree cleanup using `git branch -d`.
- Applied the same safe branch deletion to explicit CLI `cleanup run --task <id> --force`.
- Added integration assertions for branch removal in daemon and CLI cleanup paths.
- Verified focused cleanup/CLI tests and aggregate `mise exec -- bun run check`.

### Next

- Final status pass and close v1 if no remaining plan/design gaps require implementation.

## 2026-06-18 Productionization Rollout

### Did

- Added `build:bin` and `install:bin` scripts that compile and install `codex-fleet`, `codex-fleet-daemon`, `codex-fleet-mcp`, and `codex-fleet-tui`.
- Updated LaunchAgent generation and commands so launchd runs `~/.local/bin/codex-fleet-daemon run` with the Codex worker environment.
- Installed binaries to `~/.local/bin`, restarted the LaunchAgent, and verified launchd reports `state = running` with the standalone daemon path.
- Wrote `~/.codex-fleet/repos.json` for `vps-ops`, `youknowme`, `gh-agent-broker`, and `ykmcorpus`.
- Migrated Codex Desktop and Claude/Cowork MCP configs so official `codex-fleet` uses `~/.local/bin/codex-fleet-mcp`; preserved the POC as `codex-fleet-poc`.
- Fixed repo `research_only` workers to run in the registered base checkout without treating that checkout as an owned cleanup worktree.
- Smoked installed MCP as `codex` and `claudecowork`: `list_targets`, shell research, repo research, CLI/TUI visibility, logs, and cleanup dry-run all passed.
- Verified `mise exec -- bun run check`.

### Next

- Use v1 for real multi-repo work; keep `codex-fleet-poc` as fallback until confidence is higher.

## 2026-06-18 Full Task Results

### Did

- Fixed final-result persistence so workers return both full `finalResponse` and truncated `finalResponsePreview`.
- Replayed/stored full final responses in daemon task state and task history events.
- Added regression coverage proving `get_task`, `wait_tasks`, `get_task_history`, and daemon restart preserve the full response.
- Rebuilt and restarted the installed daemon; live smoke task `12fbabb5-6284-49e9-8827-117e4f105727` returned full `finalResponse` plus shorter preview.
- Verified aggregate `mise exec -- bun run check`.

### Next

- Old tasks that were already clipped before this fix remain unrecoverable unless Codex still has their thread elsewhere.

## 2026-06-18 Codex Worker YOLO Mode

### Did

- Changed the Codex worker backend so every new Codex task is launched with `sandbox: danger-full-access` and `approval-policy: never`, including `research_only` tasks.
- Kept `research_only` task instructions semantically read-only; the execution posture is now uniformly YOLO.
- Rebuilt and installed standalone binaries, then restarted the LaunchAgent daemon.
- Verified a live `research_only` shell worker can resolve `/opt/homebrew/bin/gh`, run `gh auth status` successfully, and create a temp file under `/tmp`.
- Verified aggregate `mise exec -- bun run check`.

## 2026-06-18 Review Task Post-Checks

### Did

- Tightened Codex worker delivery-mode instructions so `pr_for_review` explicitly stages intended changes, commits, pushes, opens a PR, and stops before merge.
- Added daemon post-run git inspection for repo worktrees and a `worktree_status` event with dirty-file counts and ahead/behind counts versus the repo default branch.
- Annotated final task responses when `pr_for_review`/`full_delivery`/`push_to_main` exits with uncommitted files or no commits ahead of the base branch.
- Added regression coverage for a review task that writes an untracked file and exits without committing.
- Rebuilt/installed standalone binaries, restarted the LaunchAgent daemon, and verified aggregate `mise exec -- bun run check`.

## 2026-06-18 Fresh Remote Worktree Bases

### Did

- Investigated vps-ops PR #39 conflict and found Fleet created task branch `fleet/vps-ops/cbbe5a95` from stale local `main` (`d60e0a7`) after PR #38 had already merged into `origin/main` (`8419623`).
- Fixed repo worktree creation to fetch `origin/<defaultBranch>` and create task branches from `refs/remotes/origin/<defaultBranch>` when an `origin` remote exists.
- Updated post-run worktree status inspection to compare against the freshly fetched remote default branch instead of stale local `main`.
- Added regression coverage for a stale local main with an advanced remote default branch.
- Rebuilt/installed standalone binaries, restarted the LaunchAgent daemon, and verified aggregate `mise exec -- bun run check`.

## 2026-06-18 Codex Backend Error Classification

### Did

- Investigated Cowork task `50d15418-8bbf-4e3c-92ac-1018ea0d88e1`; it exited with code 0 while its final response was a Codex backend API error: `invalid_request_error`, status 400, unsupported `image_generation` tool.
- Fixed the Codex worker backend to classify JSON `{ "type": "error", "status": 4xx/5xx }` tool payloads as nonzero worker exits while preserving the full final response.
- Added regression coverage for unsupported-tool backend error payloads.
- Rebuilt/installed standalone binaries, restarted the LaunchAgent daemon, and verified aggregate `mise exec -- bun run check`.

### Next

- Historical event-log records are append-only; the already-finished task above still shows its original exit code 0, but new matching failures will be nonzero and visible as attention items.

## 2026-06-18 Worker Stderr Persistence

### Did

- Confirmed the daemon previously requested piped Codex worker stderr but did not read or persist it.
- Added bounded per-worker stderr capture to the Codex backend.
- Persisted `workerStderr` and `workerStderrPreview` in terminal task state, task snapshots, history events, and daemon replay.
- Preserved worker startup/call failure messages as `finalResponse` alongside stderr.
- Added regression coverage for stderr capture and RPC/restart persistence.
- Rebuilt/installed standalone binaries, restarted the LaunchAgent daemon, and verified aggregate `mise exec -- bun run check`.

### Next

- TUI live activity should use Codex `codex/event` notifications plus this stderr field for process-level diagnostics.

## 2026-06-18 Worker Activity And Timeout Classification

### Did

- Investigated `youknowme` task `35909bfc-5386-412d-9200-8ce8d32b765e`: it did real work, opened PR #90, then Fleet recorded `failed_to_start` after a Codex MCP timeout.
- Added worker activity callbacks and `task_activity` replay support so long-running Codex workers refresh `lastActivityAt` without changing task state.
- Added Codex worker heartbeats plus lightweight `codex/event` activity notifications.
- Classified Codex MCP timeout errors as `timed_out` instead of `failed_to_start`.
- Fixed `codex-fleet cleanup run --task ... --dry-run` so it reports the candidate without deleting worktrees.
- Added regression coverage for activity events, timeout state, and cleanup dry-run behavior.
- Rebuilt/installed standalone binaries, restarted the LaunchAgent daemon, and verified aggregate `mise exec -- bun run check`.

### Next

- TUI can now display `task_activity` timestamps as freshness, but detailed live transcript panes still need sanitized `codex/event` persistence.

## 2026-06-18 TUI Attention Cleanup

### Did

- Released the remaining cleanup-ready Fleet worktree for task `de9007a1-6685-4f7e-83a0-0f69f2c1e202`.
- Changed the TUI Needs Attention predicate to require an existing retained worktree; already-removed worktree paths and non-actionable historical failures no longer stay pinned as attention items.
- Updated cleanup-pending summary counts and attention actions to use existing worktrees, not just historical `worktreePath` fields.
- Added TUI regression coverage for removed worktrees and terminal failures without retained worktrees.
- Rebuilt/installed standalone binaries and verified aggregate `mise exec -- bun run check`.

### Next

- Relaunch any already-running TUI process to pick up the newly installed binary.

## 2026-06-18 TUI Workflow Overhaul

### Did

- Reframed the dashboard around operator workflow: `Live`, `Action Queue`, `Stale`, and `Recent Results`/`Terminal History`.
- Stale tasks are no longer treated as live work; old stale tasks age out by default and remain available with `--all` or direct task selection.
- Renamed `Needs Attention` to `Action Queue` and kept it limited to terminal tasks with existing retained worktrees.
- Reduced dashboard refresh load by fetching history only for the currently selected task instead of every task on each refresh.
- Added regression coverage for hidden stale noise, fresh stale visibility, and retained-worktree action items.
- Rebuilt/installed standalone binaries and verified aggregate `mise exec -- bun run check`.

### Next

- Persist sanitized Codex activity events for a real per-agent transcript pane.
