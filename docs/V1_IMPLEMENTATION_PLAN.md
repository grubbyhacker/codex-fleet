# Codex Fleet V1 Implementation Plan

## Summary

Build v1 as a sequence of independently verifiable slices, with Phase 1 treated as one atomic security boundary: no usable daemon/adapter endpoint is complete until socket permissions, token auth, scopes, audit logging, durable state, and adapter proxying all work together.

This document is backlog and sequencing for building `docs/DESIGN.md`. It is not a DCR. DCRs are only for changes to product/design decisions in `docs/DESIGN.md`, not operational repo conventions, plans, or handoff notes.

## Phase 0: Planning And Repo Hygiene

- Remove operational DCRs; the handoff file is an operational convention, not a design change.
- Update `AGENTS.md` and `agent-handoff.md` so DCR guidance says: create DCRs only for design changes; plans and operational notes do not need DCRs.
- Keep this plan in `docs/V1_IMPLEMENTATION_PLAN.md`.
- Use periodic, logical commits during implementation so review can follow coherent units of work instead of one large final diff.
- Verification: `mise exec -- bun run check`; confirm `docs/DESIGN.md` unchanged.

## Phase 1: Atomic Secure Daemon And Adapter

Implement as one atomic milestone. Sub-units can land behind tests, but Phase 1 is not complete until all acceptance tests pass together.

- Shared contract:
  - Expand `packages/shared` schemas for all public MCP tools: `initialize`, `list_targets`, `delegate_task`, `get_task`, `wait_tasks`, `list_tasks`, `get_task_history`, `end_task`.
  - Define daemon RPC as newline-delimited JSON over Unix domain sockets with typed request, response, and error envelopes.
- Durable daemon core:
  - Store append-only JSONL events under `~/.codex-fleet/tasks/events.jsonl`.
  - Replay events on daemon startup into in-memory task/session state.
  - Support a fake in-process worker backend for deterministic Phase 1 tests.
- Security baseline:
  - Create `~/.codex-fleet` with `0700`, client token files with `0600`, and the socket under the same directory.
  - Store token hashes, never plaintext tokens, in daemon-owned client records.
  - Enforce scopes: orchestrator can delegate, wait, get, and end; dashboard can only list and get; CLI can do operator commands.
  - Add per-request audit JSONL records with client id, method, scope result, timestamp, and request id.
  - Never bind TCP in v1.
- MCP adapter:
  - Expose the public tools over stdio MCP.
  - Keep the adapter stateless; it reads its token at startup and proxies to the daemon.
  - Teach errors: unknown target suggests `list_targets`; bad task id suggests `list_tasks`; removed blocking behavior points to `delegate_task` plus `wait_tasks`.
- CLI minimum:
  - Add `codex-fleet client init <clientId> --role <role>` for local token bootstrap.
  - Add `codex-fleet daemon run` for foreground daemon execution.
- Verification:
  - Unit tests for schema validation, token hashing, scope checks, audit log writes, and event replay.
  - Functional tests start daemon on a temp socket, initialize a client, reject bad tokens/scopes, delegate a fake task, restart adapter, and prove `get_task` still works.
  - Run `mise exec -- bun run check` plus the integration test command added in this phase.
- Parallelism:
  - Sub-agent A can own shared schemas and contract tests.
  - Sub-agent B can own auth, token, scope, and audit modules.
  - Sub-agent C can own event store and replay.
  - Main agent owns MCP adapter integration and final security review so Phase 1 remains coherent.

## Phase 2: Registry, Worktrees, And Task-Scoped Workers

- Repo registry:
  - Add a small local daemon config for repo registry entries: alias, base checkout, default branch, branch protection flag, verify commands, and default model tier.
  - Keep shell as a built-in target, not a registry record.
- Worktree isolation:
  - For mutating repo tasks, create `~/.codex-fleet/worktrees/<repo>/<taskShort>` and branch `fleet/<repo>/<taskShort>`.
  - Never run worker edits in the base checkout.
  - For `research_only`, use read-only behavior and no branch.
- Worker lifecycle:
  - Introduce a worker backend interface with fake and Codex implementations.
  - Implement Codex worker spawning through `codex mcp-server`, with injected preamble for fresh worktree setup per `AGENTS.md`.
  - Support `resumeTaskId` via the same task/thread.
- Verification:
  - Unit tests for branch naming, registry parsing, target validation, and model-tier selection.
  - Functional tests create temp git repos and prove two fake-worker repo tasks get distinct worktrees/branches and never touch the base checkout.
- Parallelism:
  - Worktree manager, registry loader, and Codex worker backend can be implemented in parallel with disjoint files.

## Phase 3: wait_tasks, Supervision, And Operational State

- Implement bounded `wait_tasks(taskIds, sinceEventSeq, maxWaitSeconds, returnOnStatuses)` with a server-side cap of 45 seconds.
- Track only operational states: `queued`, `running`, `exited`, `failed_to_start`, `cancelled`, `timed_out`, `stale`.
- Capture process start, liveness, last activity, exit code, final output preview, and event deltas.
- Implement `list_tasks`, `get_task_history`, and session scoping by `clientId` plus optional `sessionName`.
- Verification:
  - Unit tests for event cursors, stale detection, terminal-state filtering, and session scoping.
  - Functional tests cover quiet worker becomes `stale`, worker exit without final output reports `exited` plus `exitCode`, and bounded waits return on event or timeout.
- Parallelism:
  - Supervision/state machine and API/query work can run in parallel after event schema stabilizes.

## Phase 4: Cleanup And Operator CLI

- Implement `end_task` release semantics: do not clean on worker exit; clean only after `end_task` or TTL.
- Use `git worktree remove` and `git worktree prune`; block cleanup on dirty worktrees and report `cleanup_blocked_dirty`.
- Add CLI views and operator actions:
  - `codex-fleet list`, `status`, `watch`, `logs`.
  - `codex-fleet cleanup list --dry-run`.
  - `codex-fleet cleanup run --task <id>` with an explicit force path for dirty worktrees.
- Keep cleanup out of MCP except `end_task`.
- Verification:
  - Unit tests for cleanup candidate classification.
  - Functional tests for clean worktree removal, dirty worktree blocking, branch retention/deletion rules, and stale lock reporting.
- Parallelism:
  - CLI read-only commands and cleanup engine can be built in parallel once daemon RPC is stable.

## Phase 5: Observability TUI

- Add OpenTUI dependencies only when this phase starts.
- Build a read-only dashboard over daemon RPC/event stream:
  - summary counts;
  - sessions grouped by owner session;
  - task rows with target, state, and last activity;
  - task detail with branch, worktree, resources, last output, and event timeline;
  - usage counters from durable task state.
- Allow session rename as the only write affordance.
- Verification:
  - Unit tests for dashboard data selectors and formatting.
  - Functional render test using fake daemon data.
  - Manual smoke test on macOS terminal after automated tests pass.
- Parallelism:
  - TUI can be implemented by a sub-agent while main agent continues CLI/API hardening, provided RPC response types are frozen.

## Phase 6: Sparse Real-Codex E2E

Keep these opt-in because they spend paid tokens.

- Add `mise exec -- bun run test:e2e:codex`, skipped unless `CODEX_FLEET_RUN_CODEX_E2E=1`.
- Use `CODEX_FLEET_E2E_MODEL`, defaulting to `gpt-5.3-codex-spark` as the cheapest currently exposed coding model in this environment; allow override without code changes.
- Add a cheap preflight that runs one minimal `codex exec --ephemeral -m "$CODEX_FLEET_E2E_MODEL"` prompt and fails clearly if the model is unavailable.
- E2E scenarios:
  - actual Codex shell/research task returns a final response through daemon and adapter;
  - actual Codex repo patch task edits a tiny temp fixture repo in an isolated worktree, runs a trivial verify command, and leaves the base checkout untouched;
  - adapter restart during an in-flight fake or low-cost Codex task does not lose daemon state.
- Do not include pushing, PR creation, merge, deploy, or production SSH in automated E2E v1.
- Verification:
  - Normal CI/local `mise exec -- bun run check` never runs paid E2E.
  - Paid E2E logs model used, task id, token-risk warning, and temp paths; it never records full prompts/responses unless retention is explicitly enabled.

## Phase 7: V1 Hardening And Service Install

- Add macOS LaunchAgent support first; Linux `systemd --user` can follow if needed.
- Add daemon startup checks:
  - refuse root;
  - verify state dir permissions;
  - remove stale socket only when no daemon owns it;
  - emit actionable diagnostics.
- Add token rotation if implementation experience shows it is small; otherwise leave as a documented v1.x follow-up.
- Add model-tier enforcement and logging:
  - requested vs actual model;
  - forbid cheap tier for `risk: high`, `full_delivery`, and `push_to_main`;
  - explicit fallback event when requested tier is unavailable.
- Verification:
  - Unit tests for startup permission checks and model-tier rules.
  - Functional test for daemon restart from existing event log and socket recovery.
  - Manual LaunchAgent smoke test only after foreground daemon path is stable.

## Learning And DCR Rules

- Each phase should end with a short handoff entry: what changed, what passed, what is risky next.
- Commit periodically at logical boundaries: after each independently verified subsystem, after each phase gate, and before starting risky cross-cutting integration.
- Keep commits reviewable: one coherent behavior change per commit, with passing relevant tests noted in the commit message or handoff.
- Do not mix unrelated cleanup, formatting churn, and feature behavior in the same commit unless the cleanup is required for that behavior.
- Create a DCR only when implementation changes a product/design decision in `docs/DESIGN.md`, such as replacing JSONL with SQLite in v1, changing the public API, adding TCP, or weakening auth.
- Do not create DCRs for plans, handoffs, command notes, test additions, or implementation sequencing.
- If learning reveals a safer implementation that preserves the design intent, document it in the plan or handoff and continue.
- If learning requires weakening Phase 1 security, changing public API semantics, or spending paid Codex E2E tokens beyond the sparse suite, stop and ask before proceeding.
