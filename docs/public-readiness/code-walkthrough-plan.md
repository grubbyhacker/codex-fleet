# Code Walkthrough Plan: Public Readiness

## Purpose

This plan defines the architecture questions we should answer before publishing a public-facing code walkthrough and maps each question to exact source files.

## 1) What does the public contract look like?

- `docs/CODE_WALKTHROUGH.md` should explain the end-to-end request flow.
- Source references:
  - `docs/DESIGN.md` (public API contract and architecture intent)
  - `packages/shared/src/index.ts` (canonical schemas/enums/typing)
  - `packages/cli/src/index.ts` (public `codex-fleet` commands that consume daemon RPC)
  - `packages/mcp-adapter/src/index.ts` (MCP wrapper/proxy for public orchestration clients)
  - `packages/tui/src/index.ts` (read-only status UI)

## 2) How is the daemon process started, hardened, and exposed over a local API?

- Need to cover startup lifecycle, root/sandboxing assumptions, socket ownership, stale socket handling, and startup checks.
- Source references:
  - `packages/daemon/src/rpc/server.ts`
  - `packages/daemon/src/paths.ts`
  - `packages/daemon/src/index.ts`
  - `packages/cli/src/index.ts` (`daemon run` and launch-agent integration)
  - `packages/daemon/src/rpc/audit.ts` (audit sink on every request path)
  - `test/integration/startup-hardening.test.ts`

## 3) How are authentication, sessions, scopes, and authorization enforced?

- Include identity material, token storage, role->scope mapping, per-method authorization, and failure modes.
- Source references:
  - `packages/daemon/src/rpc/auth.ts`
  - `packages/daemon/src/rpc/server.ts` (authenticate/authorize around each request)
  - `test/integration/auth.test.ts`
  - `test/integration/rpc.test.ts`
  - `test/integration/cli.test.ts` (client role behavior across clients)

## 4) How are sessions and task ownership tracked?

- Explain `ownerSession`, initialize/session reattach behavior, dashboard/visibility filtering.
- Source references:
  - `packages/daemon/src/service.ts` (`ownerFor`, `requireTask`, `visibleTasks`)
  - `packages/shared/src/index.ts` (`initializeRequestSchema`, `ownerSessionSchema`)
  - `test/integration/tui.test.ts`
  - `test/integration/rpc.test.ts`

## 5) How does the state model work and how is durability achieved?

- Cover event log append/replay strategy, in-memory materialized state, compact task snapshots, history queries.
- Source references:
  - `packages/daemon/src/store/event-log.ts`
  - `packages/daemon/src/store/state.ts`
  - `packages/daemon/src/service.ts` (`append`, `handle`, `runWorker`, `refreshStaleTasks`)
  - `test/integration/event-store.test.ts`
  - `test/integration/rpc.test.ts` (state survives restart)

## 6) How are repo targets resolved and prepared?

- Explain repo registry loading, entry schema, mirror versus base checkout paths, and branch start-point behavior.
- Source references:
  - `packages/daemon/src/registry/repo-registry.ts`
  - `packages/daemon/src/registry/repo-source-manager.ts`
  - `packages/daemon/src/paths.ts`
  - `test/integration/worktree.test.ts`

## 7) How are workers launched and run?

- Clarify worker abstraction, Codex backend execution path, and how task output/state is captured.
- Source references:
  - `packages/daemon/src/workers/backend.ts`
  - `packages/daemon/src/workers/codex-backend.ts`
  - `packages/daemon/src/service.ts` (`runWorker`, `append` events)
  - `packages/daemon/src/git.ts` (tooling lookup)
  - `test/integration/codex-backend.test.ts`
  - `test/integration/supervision.test.ts`

## 8) How does task lifecycle behave from delegate to completion?

- Include state transitions, activity events, wait semantics, timeout/failure handling, and stale detection.
- Source references:
  - `packages/daemon/src/service.ts` (`delegateTask`, `runWorker`, `waitTasks`, `refreshStaleTasks`, `resumeTask`)
  - `packages/daemon/src/store/state.ts` (`task_state` handling)
  - `packages/daemon/src/store/event-log.ts` (event payload persistence)
  - `test/integration/supervision.test.ts`
  - `test/integration/rpc.test.ts`

## 9) How are cleanup and branch/worktree reclamation handled?

- Explain cleanup safety checks, stale worktrees, dry-run behavior, and shell directory cleanup.
- Source references:
  - `packages/daemon/src/cleanup/cleanup-manager.ts`
  - `packages/daemon/src/worktree/worktree-manager.ts`
  - `packages/daemon/src/service.ts` (`end_task`, shell path allocation)
  - `packages/cli/src/index.ts` (cleanup UX + forced cleanup)
  - `test/integration/cleanup.test.ts`
  - `test/integration/worktree.test.ts`

## 10) How does logging and auditability work?

- Distinguish event log vs audit log and what each captures.
- Source references:
  - `packages/daemon/src/store/event-log.ts`
  - `packages/daemon/src/store/state.ts`
  - `packages/daemon/src/rpc/audit.ts`
  - `test/integration/auth.test.ts`
  - `test/integration/rpc.test.ts`

## 11) How do adapter/CLI/TUI consume daemon state?

- Demonstrate that clients are stateless, role-scoped, and derive from the same API contracts.
- Source references:
  - `packages/mcp-adapter/src/index.ts`
  - `packages/cli/src/index.ts`
  - `packages/tui/src/index.ts`
  - `test/integration/mcp-adapter.test.ts`
  - `test/integration/cli.test.ts`
  - `test/integration/tui.test.ts`

## 12) How does model routing work and where can it be extended?

- Address safety upgrades, unavailable-tier fallback behavior, and requested vs actual model capture.
- Source references:
  - `packages/daemon/src/service.ts` (`routeModelTier`, `availableModelTiersFromEnv`)
  - `test/integration/model-routing.test.ts`

## 13) How is the code tested and what does coverage currently guarantee?

- Include test groups by subsystem, and identify hardening/observability coverage.
- Source references:
  - `package.json` scripts (`check`, `typecheck`, `lint`, `format:check`, `test`)
  - `test/integration/*.test.ts`
  - `test/schema/shared-schemas.test.ts`

## 14) Which files are extension points for future iterations?

- Document extension seams that are intended and already surfaced by config or interfaces.
- Source references:
  - `packages/daemon/src/workers/backend.ts` (`WorkerBackend` interface)
  - `packages/daemon/src/service.ts` (workerBackendFromEnv and service composition)
  - `packages/daemon/src/registry/repo-registry.ts` (repo list schema/loader)
  - `packages/daemon/src/paths.ts` (state layout and socket path overrides)
  - `packages/daemon/src/rpc/server.ts` (`daemonMethod` set and method dispatch)
