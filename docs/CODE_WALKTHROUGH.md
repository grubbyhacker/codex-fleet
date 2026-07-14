# CODE_WALKTHROUGH

This document is the architecture walkthrough for preparing codex-fleet for public consumption.

## 1) System shape at a glance

- [packages/daemon/src/rpc/server.ts](../packages/daemon/src/rpc/server.ts)
  runs a long-lived daemon on a Unix socket and dispatches every request through one permissioned method surface.
- [packages/daemon/src/rpc/auth.ts](../packages/daemon/src/rpc/auth.ts)
  verifies clients and enforces method scopes.
- [packages/daemon/src/service.ts](../packages/daemon/src/service.ts)
  holds orchestration policy: target resolution, task creation, model routing, wait/visibility logic, and event emission.
- [packages/shared/src/index.ts](../packages/shared/src/index.ts)
  contains the transport contract (schemas, method names, state models).
- Client entrypoints:
  - [packages/mcp-adapter/src/index.ts](../packages/mcp-adapter/src/index.ts)
  - [packages/cli/src/index.ts](../packages/cli/src/index.ts)
  - [packages/tui/src/index.ts](../packages/tui/src/index.ts)

The architecture is centered on one durable daemon process with multiple stateless frontends.

## 2) Public contract and message flow

### 2.1 API methods

The public methods are defined as: `initialize`, `list_targets`, `delegate_task`, `get_task`, `wait_tasks`, `list_tasks`, `get_task_history`, `end_task`.

- Method enum and request/response schemas: [packages/shared/src/index.ts](../packages/shared/src/index.ts)
- Dispatch and validation: [packages/daemon/src/rpc/server.ts](../packages/daemon/src/rpc/server.ts)
- RPC envelope parsing and response validation: [packages/daemon/src/rpc/client.ts](../packages/daemon/src/rpc/client.ts)

### 2.2 End-to-end request flow

```text
MCP Tool / CLI / TUI -> callDaemon -> TCP/Unix socket -> rpc/server.ts -> service.handle -> FleetState/EventLog -> worker run loop
```

- API transport parsing and JSONL framing is done per line in `server.ts`; each line must parse as one `rpcEnvelopeSchema` message.
- `daemonMethod` routing then maps to `FleetService.handle`.

### 2.3 Why this shape

- Adapter/CLI/TUI are thin clients and do not own task truth.
- Task truth, events, and visibility are daemon-owned and replayable.

## 3) Socket/API internals

### 3.1 Socket lifecycle and startup hardening

- Socket path selection and directory resolution: [packages/daemon/src/paths.ts](../packages/daemon/src/paths.ts)
  - `defaultFleetRoot()` defaults to `~/.codex-fleet` and allows override via `CODEX_FLEET_STATE_DIR`.
  - `resolveFleetPaths(...).socketPath` uses `CODEX_FLEET_SOCKET` or `<root>/daemon.sock`.
- Listener startup and stale socket handling:
  - stale socket check and active socket refusal in [packages/daemon/src/rpc/server.ts](../packages/daemon/src/rpc/server.ts)
  - `removeStaleSocket`, `socketAcceptsConnections`, and stale path removal.
- Startup hardening coverage:
  - refuses active socket replacement: [test/integration/startup-hardening.test.ts](../test/integration/startup-hardening.test.ts)
  - repairs state perms and stale socket cleanup on startup.

### 3.2 Audit of every request

- Requests append accepted/rejected records in [packages/daemon/src/rpc/audit.ts](../packages/daemon/src/rpc/audit.ts).
- Verified in integration tests: [test/integration/auth.test.ts](../test/integration/auth.test.ts).

### 3.3 CLI daemon entry and CLI daemon command

- Daemon process CLI entry is [packages/daemon/src/index.ts](../packages/daemon/src/index.ts) (`import.meta.main`, `--probe`, `run`).
- Public CLI wrapper points to daemon run/install/launch-agent in [packages/cli/src/index.ts](../packages/cli/src/index.ts).

## 4) Auth, roles, and session ownership

### 4.1 Identity and stored credentials

- `createClient`, `loadClient`, `readClientToken`: [packages/daemon/src/rpc/auth.ts](../packages/daemon/src/rpc/auth.ts)
  - Writes `client.json` (`scopes` + token hash) with mode `0600` and `token` file (plain text token) with mode `0600`.
  - `ensureStateLayout` creates `clients`, `repos`, `shell`, `tasks`, `worktrees` under root with `0700`.
- Role and scope model:
  - `orchestrator` scopes: `delegate`, `wait`, `get`, `list`, `end_task`
  - `dashboard` scopes: `get`, `list`
  - `cli` scopes: plus `cleanup`, `admin`
  - Defined in [packages/daemon/src/rpc/auth.ts](../packages/daemon/src/rpc/auth.ts).

### 4.2 Authorization decision per method

- The server calls `authenticate` then `authorize`, deriving required scope via `requiredScope` and `methodScopes`.
- `daemonMethodSchema` parsing ensures unknown methods fail fast.
- Errors mapped to response codes in [packages/daemon/src/rpc/errors.ts](../packages/daemon/src/rpc/errors.ts).

### 4.3 Session keying and owner visibility

- Session tuple = `{ clientId, sessionName? }` with persistence on `initialize`.
- Ownership filtering in [packages/daemon/src/service.ts](../packages/daemon/src/service.ts) via `ownerFor`, `requireTask`, `visibleTasks`.
- If no explicit `initialize`, fall back to `clientId` ownership.

## 5) Tasks, events, and durable state model

### 5.1 Event sourcing model

- Event stream stored in one JSONL file: [packages/daemon/src/store/event-log.ts](../packages/daemon/src/store/event-log.ts)
  - `append()` is fsync-backed and write-once append.
  - `readAll()` hydrates all events on startup.
- In-memory projection: [packages/daemon/src/store/state.ts](../packages/daemon/src/store/state.ts)
  - Replays events via `FleetState.replay`.
  - Handles `task_created`, `task_resumed`, `task_state`, `task_resource`, `task_activity`; observation-only events are retained in history without changing task state.

### 5.2 Task fields and state lifecycle

- State enum: `queued`, `running`, `exited`, `failed_to_start`, `cancelled`, `timed_out`, `stale`.
  - See type and snapshots in [packages/shared/src/index.ts](../packages/shared/src/index.ts).
- Transitions and side effects live in [packages/daemon/src/service.ts](../packages/daemon/src/service.ts), especially:
  - `delegateTask` emits `task_created`, optional `model_routing`, optional `task_resource`, initial `task_state` (`running`)
  - `runWorker` emits `task_state` on exit/failure/timeout
  - `refreshStaleTasks` upgrades stale `running` tasks
  - `waitTasks` uses interruptible event notifications and returns snapshots, coalesced event deltas, `nextEventSeq`, `wakeReason`, and suggested backoff. It emits `task_observation` when an active task stays quiet for a wait slice.

### 5.3 Staleness and wait semantics

- `staleAfterMs` defaults to 5 minutes; long-running no-activity tasks move to `stale`.
- `wait_tasks` supports `wakeOn` modes: `any_event` preserves immediate event following, `material_event` ignores activity/observation wakeups, and `requested_status` coalesces events until a requested state or timeout.
- `requested_status` requires `returnOnStatuses`; terminal or stale transitions interrupt the wait immediately.
- Compact snapshots omit retained prompt/output/stderr bodies by default while preserving previews; callers can request `snapshotDetail: "full"`.
- Design/limits are enforced by schema `maxWaitSeconds <= 45` in shared schema.

### 5.4 Event and history guarantees

- `get_task_history` returns event window from in-memory `FleetState.events`.
- Full task final output and stderr are retained in `task_state` payloads, while list queries intentionally compact older rows.
- Tests proving snapshot compactness/history retention:
  - [test/integration/rpc.test.ts](../test/integration/rpc.test.ts)
  - [test/integration/event-store.test.ts](../test/integration/event-store.test.ts)

## 6) Repo registry and source preparation

### 6.1 Registry schema and loading

- Repo config schema + alias loading: [packages/daemon/src/registry/repo-registry.ts](../packages/daemon/src/registry/repo-registry.ts)
  - Supports `remoteUrl` or `baseCheckout` source; default model tier and branch policy included in each descriptor.

### 6.2 Source resolution and mirrors

- Source prep: [packages/daemon/src/registry/repo-source-manager.ts](../packages/daemon/src/registry/repo-source-manager.ts)
  - `prepare(repo)` creates or validates bare mirror when `remoteUrl` is used.
  - `resolveFreshDefaultStartPoint` fetches branch refs before task execution.
- Worktree creation: [packages/daemon/src/worktree/worktree-manager.ts](../packages/daemon/src/worktree/worktree-manager.ts)
  - `fleet/<alias>/<taskShort>` branch pattern when mutating.

### 6.3 Registry usage in delegate path

- Target list for clients is built from shell pseudo-target plus registry descriptors.
- Unknown repo alias fails early in `delegateTask` with not_found.

## 7) Worker lifecycle and execution backend

### 7.1 Worker abstraction

- Interface boundary: [packages/daemon/src/workers/backend.ts](../packages/daemon/src/workers/backend.ts)
  - `WorkerBackend`, `WorkerInput`, `WorkerResult`, `WorkerRunError`.

### 7.2 Default backend selection

- `workerBackendFromEnv()` in [packages/daemon/src/workers/codex-backend.ts](../packages/daemon/src/workers/codex-backend.ts)
  - `CODEX_FLEET_WORKER_BACKEND=codex` enables live Codex backend.
  - Otherwise uses `FakeWorkerBackend` for deterministic/faster execution.

### 7.3 Runtime behavior of Codex worker

- Launch path uses MCP stdio transport and `codex` tool calls:
  - [packages/daemon/src/workers/codex-backend.ts](../packages/daemon/src/workers/codex-backend.ts)
  - command resolved by `resolveCodexCommand` with env overrides and candidate fallbacks.
- Developer instructions are generated per request:
  - repo worktree context, shell restrictions, delivery mode semantics, large-file guardrails.
- Result handling:
  - parse tool output with `codexWorkerResultFromToolResult`
  - map backend error payloads to `exitCode: 1`
  - capture stderr stream in bounded buffer and append on final result.

### 7.4 Supervision and activity

- `runWorker` in [packages/daemon/src/service.ts](../packages/daemon/src/service.ts)
  - records periodic `task_activity` (`heartbeat` / `codex_event` events)
  - preserves important Codex tool boundary telemetry despite normal activity throttling
  - appends terminal `task_state` with final response and codex thread id.
- Activity and timeout behavior is tested in [test/integration/supervision.test.ts](../test/integration/supervision.test.ts).

## 8) Model routing and safety limits

- Routing logic in [packages/daemon/src/service.ts](../packages/daemon/src/service.ts):
  - `modelRouting` computes `requestedModel`, `defaultModelTier`, `actualModel`, `availableModelTiersFromEnv`.
  - `routeModelRoute` computes `requestedModelRoute`, `actualModelRoute`, and `availableModelRoutes`.
  - Enforces minimum tier from `risk` + delivery mode and raises conflict when no eligible tier exists.
  - Emits `model_routing` when requested tier is unavailable and fallback used.
  - Emits `model_route` when an orchestrator explicitly requests a route such as `gpt-5.6-sol`.
- Codex worker launch config in [packages/daemon/src/workers/codex-backend.ts](../packages/daemon/src/workers/codex-backend.ts):
  - maps the default route to `gpt-5.6-terra`;
  - maps explicit GPT-5.6 routes to `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol`;
  - accepts per-route and per-tier env overrides such as `CODEX_FLEET_CODEX_MODEL_ROUTE_GPT_5_6_TERRA`, `CODEX_FLEET_CODEX_MODEL_CHEAP`, and `CODEX_FLEET_CODEX_REASONING_EFFORT_CHEAP`.
- Env var `CODEX_FLEET_AVAILABLE_MODEL_TIERS` drives available set.
- Env var `CODEX_FLEET_AVAILABLE_MODEL_ROUTES` drives available concrete route set.
- Coverage: [test/integration/model-routing.test.ts](../test/integration/model-routing.test.ts)

## 9) Cleanup and resource release

### 9.1 Shell path allocation

- Shell tasks allocate ephemeral directory via `allocateShellPath` in [packages/daemon/src/service.ts](../packages/daemon/src/service.ts).

### 9.2 Worktree release process

- Cleanup manager: [packages/daemon/src/cleanup/cleanup-manager.ts](../packages/daemon/src/cleanup/cleanup-manager.ts)
  - For terminal tasks: verify there are no tracked or untracked changes, make Fleet-owned artifacts owner-writable, remove ignored build caches with `git clean -ffdx`, then force-remove and prune the worktree.
  - Branch deletion via `git branch -d` helper.
  - Dirty worktrees return `cleanup_blocked_dirty` and must be handled explicitly.
- `end_task` endpoint calls cleanup path in service:
  - shell cleanup (`rm -rf` shell dir)
  - repo worktree cleanup + branch handling.
- CLI cleanup commands and actions in [packages/cli/src/index.ts](../packages/cli/src/index.ts)
  - `cleanup list`, `cleanup run`, `cleanup run --force`, `cleanup wipe-clean`.

### 9.3 Coverage

- [test/integration/cleanup.test.ts](../test/integration/cleanup.test.ts)
- [test/integration/worktree.test.ts](../test/integration/worktree.test.ts)

## 10) Logging and observability

### 10.1 Durable events

- Task timeline and audit data live in two files:
  - `tasks/events.jsonl` via [packages/daemon/src/store/event-log.ts](../packages/daemon/src/store/event-log.ts)
  - `audit.jsonl` via [packages/daemon/src/rpc/audit.ts](../packages/daemon/src/rpc/audit.ts)

### 10.2 What gets logged

- `task_created`, `task_resumed`, `task_resource`, `task_activity`, `task_observation`, `task_state`, `worktree_status`.
- Error paths include `WorkerRunError` state and previews via summary payloads.

### 10.3 Surface in UI

- TUI renders event history when task is selected and can format snapshots/historical activity in `renderDashboard`.
- [packages/tui/src/index.ts](../packages/tui/src/index.ts), especially `loadDashboardData`, `runDashboard`, and rendering helpers.
- Verified by [test/integration/tui.test.ts](../test/integration/tui.test.ts).

## 11) Client surfaces and their responsibilities

### 11.1 MCP adapter

- [packages/mcp-adapter/src/index.ts](../packages/mcp-adapter/src/index.ts)
  - Registers one MCP tool per daemon method.
  - Proxy is stateless; all state comes from daemon responses.
  - Tool output serialized into MCP text content.
- Integration: [test/integration/mcp-adapter.test.ts](../test/integration/mcp-adapter.test.ts)

### 11.2 CLI

- `list`, `status`, `logs`, `watch`, `cleanup`, and service launch-agent actions in [packages/cli/src/index.ts](../packages/cli/src/index.ts).
- Uses `callDaemon(...)` and role-scoped identities. Coverage: [test/integration/cli.test.ts](../test/integration/cli.test.ts).

### 11.3 TUI

- Read-only dashboard reads snapshots/history and renders sections:
  - visible tasks, selected task detail, events pane
  - action queue derived from terminal tasks with retained worktrees.
- Core render path: `loadDashboardData` + `renderDashboard` + `renderDashboardForOpenTui` in [packages/tui/src/index.ts](../packages/tui/src/index.ts).
- Live refresh defaults to five seconds and caches selected-task detail/history while the selected compact row is unchanged.
- Coverage: [test/integration/tui.test.ts](../test/integration/tui.test.ts).

## 12) Test strategy and confidence map

### 12.1 Commanded validation set

- Full check command: [package.json](../package.json) (`typecheck`, `lint`, `format:check`, `test`).
- `test` runs unit/integration/e2e under Vitest.

### 12.2 Subsystem coverage

- Contract & schema correctness: [test/schema/shared-schemas.test.ts](../test/schema/shared-schemas.test.ts)
- RPC + auth + restart durability: [test/integration/rpc.test.ts](../test/integration/rpc.test.ts)
- Auth/audit store hygiene: [test/integration/auth.test.ts](../test/integration/auth.test.ts)
- Worktree and registry correctness: [test/integration/worktree.test.ts](../test/integration/worktree.test.ts)
- Worker backend behavior and developer instructions: [test/integration/codex-backend.test.ts](../test/integration/codex-backend.test.ts)
- Lifecycle/supervision/timeout: [test/integration/supervision.test.ts](../test/integration/supervision.test.ts)
- CLI/TUI adapters and user visibility: [test/integration/cli.test.ts](../test/integration/cli.test.ts), [test/integration/tui.test.ts](../test/integration/tui.test.ts)
- End-to-end task flow through real Codex worker path: [test/e2e/codex.test.ts](../test/e2e/codex.test.ts)

## 13) Extension points (design-safe)

- Swap worker backend by implementing `WorkerBackend`:
  - interface: [packages/daemon/src/workers/backend.ts](../packages/daemon/src/workers/backend.ts)
  - env-based selection in [packages/daemon/src/workers/codex-backend.ts](../packages/daemon/src/workers/codex-backend.ts)
- Repo surface can be expanded through registry JSON + `repo-registry.ts` schema:
  - [packages/daemon/src/registry/repo-registry.ts](../packages/daemon/src/registry/repo-registry.ts)
- Transport and method surface can be extended by extending method enums and adding handler branches:
  - [packages/shared/src/index.ts](../packages/shared/src/index.ts)
  - [packages/daemon/src/service.ts](../packages/daemon/src/service.ts)
  - [packages/daemon/src/rpc/server.ts](../packages/daemon/src/rpc/server.ts)
- Socket and filesystem layout are overridable via env-backed path functions:
  - [packages/daemon/src/paths.ts](../packages/daemon/src/paths.ts)

## 14) Known caveats (current)

- No remote/TCP auth in this version; transport is local Unix socket only.
- Session scoping is client/session based, no multi-operator trust boundary beyond local filesystem and permissions.
- Cleanup is explicit (`end_task` / CLI action queue) rather than automatic TTL-driven by default.
- Task execution policy is still Codex-oriented; orchestration layer is engine-agnostic by contract but implementation assumes Codex-like worker instructions.

## 15) Quick “where to continue reading” map

- Source of truth architecture: [docs/DESIGN.md](DESIGN.md)
- Production run-shape and rollout assumptions: [docs/PRODUCTIONIZATION_PLAN.md](PRODUCTIONIZATION_PLAN.md)
- Durable state notes / change tracking in `docs/` as needed.
