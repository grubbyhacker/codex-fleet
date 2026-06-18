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
