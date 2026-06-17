# Codex Fleet — Design

Status: Draft v1 · Date: 2026-06-17 · Supersedes the POC in `README.md`

A greenfield design for Codex orchestration and observability. The existing single-file broker (`src/codex-fleet-mcp.ts`) is a prototype that validated the idea, not the foundation to extend. Most decisions trace back to a lesson in `LEARNINGS.md` (mapped in the appendix); the rest are forward choices, noted where they appear.

---

## 1. Goals and non-goals

Codex Fleet lets one **Orchestrator** — the agent the operator drives (Claude/Cowork today, any MCP client later) — delegate real work to a fleet of **Workers**, the Codex agents it spawns, and lets a human see what the fleet is doing. "Real work" means repo changes carried to merged PRs, plus host operations like production SSH, Docker staging, and diagnostics. The Orchestrator stays high-level and sandboxed; Workers do the environment-specific execution. The POC proved the value — agent-to-agent delegation produced merged PRs with the human mostly out of the loop. This design makes that durable, observable, parallel-safe, and secure.

**Principles.**

1. **Durable state outside the MCP connection.** The Orchestrator's connection is disposable; task state, threads, worktrees, and logs are not. They survive an Orchestrator restart.
2. **The easy path is the correct path.** Orchestrating agents choose badly among similar tools. Expose one obvious way to do each thing; let the daemon make the subtle calls.
3. **Operational facts, not semantic completion.** Codex Fleet reports only what it observes (process alive/exited, last activity, final output, resources created). The Orchestrator decides whether the work was good enough.
4. **Isolation by default.** A repo-mutating task gets its own worktree and branch. Shared checkouts are templates, never workspaces.
5. **Broad privilege demands auditability.** Workers run with broad access on purpose — that's what lets them run tests, git, Docker, SSH, and deploys without escalating every step. Because that power can do real damage, everything the daemon owns — every task, request, worker lifecycle event, and captured worker output — is attributable and logged (§9, §11). Visibility into individual shell/tool actions is only as complete as what Codex emits (§8).
6. **The public API names no backend.** Nothing the Orchestrator calls mentions Codex. The surface speaks in tasks, targets, and Workers, so the engine behind them can change — other coding agents, a different backend — without changing the client (§4).

**Non-goals (v1).** Not a general agent runtime (Workers are Codex CLI processes). Not multi-user (single operator; multi-user is a later security epic). Not a terminal multiplexer (observability is task-aware and may *drive* cmux/herdr, not reimplement them).

---

## 2. Architecture

A stdio MCP server's lifetime is owned by the Orchestrator that launches it, so an Orchestrator restart wipes in-memory state — the POC's core fragility. The fix is three tiers, with only the thinnest one tied to the Orchestrator.

```
┌─────────────────────────────────────────────────────────────┐
│  Orchestrator (Claude/Cowork, other MCP clients)             │
└───────────────┬─────────────────────────────────────────────┘
                │ stdio MCP (disposable, reconnectable)
┌───────────────▼─────────────────────────────────────────────┐
│  MCP stdio adapter  — thin, stateless proxy                  │
│  translates MCP tool calls ⇄ daemon RPC over Unix socket     │
└───────────────┬─────────────────────────────────────────────┘
                │ Unix domain socket (authenticated, local)
┌───────────────▼─────────────────────────────────────────────┐
│  codex-fleet daemon  — durable, long-lived, source of truth  │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ task store │ │ scheduler│ │ worktree │ │ supervisor   │  │
│  │ + events   │ │ + queue  │ │ manager  │ │ (proc state) │  │
│  └────────────┘ └────┬─────┘ └──────────┘ └──────────────┘  │
│  ┌──────────────┐    │   ┌──────────────┐ ┌──────────────┐  │
│  │ repo registry│    │   │ shell access │ │ cleanup      │  │
│  │              │    │   │              │ │              │  │
│  └──────────────┘    │   └──────────────┘ └──────────────┘  │
└──────────────────────┼──────────────────────────────────────┘
                       │ spawns / supervises
       ┌───────────────┼───────────────┐
┌──────▼─────┐  ┌───────▼────┐  ┌───────▼────┐
│ codex      │  │ codex      │  │ codex      │   one native codex
│ mcp-server │  │ mcp-server │  │ mcp-server │   process per task
│ (worktree) │  │ (worktree) │  │ (shell)    │
└────────────┘  └────────────┘  └────────────┘

Side consumers of daemon state (same socket/RPC):
   CLI (codex-fleet ...) · TUI dashboard · scheduler · web view
```

The three tiers in the diagram above:

**Adapter** — a process the Orchestrator launches and may kill anytime. No state. Authenticates with a token, forwards tool calls, streams results. Restart it and `get_task` still works.

**Daemon** — the durable source of truth. Owns the task store and event log, scheduler/queue, Worker supervision (liveness, activity, exit), worktree/branch lifecycle, cleanup, and the repo registry. One local RPC interface, consumed equally by the adapter, CLI, TUI, and scheduler.

**Workers** — native `codex mcp-server` subprocesses, spawned per task. A repo-mutating Worker runs inside its own worktree. The daemon owns each Worker's lifecycle, access, and model tier.

The reason for a daemon rather than a library is durability: a delegated task should outlive the Orchestrator's connection, so the Orchestrator can be restarted (for its own context reasons) without killing in-flight work. State that lived in the Orchestrator-launched process couldn't do that, which also caused the POC's duplicate-broker churn on reconnect. A daemon also gives every view one coherent state to read instead of re-deriving truth from git, logs, and `ps`.

### Service shape — how the daemon runs

The daemon runs as a **user-level service**, not a container. On macOS that's a launchd LaunchAgent; on Linux, `systemd --user`. It starts on login, restarts on crash, and runs as the operator's user account — which is exactly what the §9 trust model assumes (it owns `~/.codex-fleet` and the socket; peer-UID checks key off that UID).

It is **not** containerized, and that's deliberate. The daemon's whole job is to reach host resources on the operator's behalf — the Codex login, the repos and their toolchains, git, SSH keys, the Docker socket for staging, `gh` credentials. Containerizing it would mean mounting or passing through essentially all of that plus bind-mounting the socket back to the host for the adapter — host-privileged in every way that matters, with the operational cost of a container and none of the isolation benefit. It would also fight §5's host self-bootstrap (the image would have to reproduce every repo's environment) and §9's OS-user trust model. Structurally it can't be half-done either: the daemon spawns Workers as child processes, so containerizing the daemon containerizes the Workers, which then need the host access anyway.

Containerization belongs one layer down and later: around **Workers**, to sandbox untrusted repo code and limit blast radius (per-task worktrees are the v1 isolation; `gh-agent-broker` containers are a §9 future). A remote or shared daemon host is a separate, post-v1 concern tied to the multi-user/TCP path the rest of the doc fences off.

The adapter stays a thin process Cowork launches that simply connects to the already-running daemon (and may auto-start it if it isn't up). Because the daemon's lifetime is independent of any adapter or Cowork restart, in-flight tasks survive both.

---

## 3. Worker and task model

**A task is the unit of work — but only an operational one.** Codex Fleet does not define a task by its content. A task is just one delegation the daemon tracks: one worktree, one log, one lifecycle. "Update a README" and "refactor six interfaces and integration-test in staging" are both tasks; the daemon never judges their size or meaning. This is the same stance as §6 — operational facts, not semantics.

**A Worker is scoped to a task, not a repo.** The POC ran exactly one long-lived Worker per repo, which made it accumulate unrelated context, serialized everything against that repo, and collided in the shared checkout. Instead, each task gets its own Worker: a fresh Codex process in its own worktree/branch that exits when the task ends. Two tasks on the same repo get two worktrees and run in parallel.

**A task can be a conversation.** To send a follow-up — "that failed, try Y" — the Orchestrator calls `delegate_task` again with `resumeTaskId` set to that task. The same Worker continues its thread (internally, Codex's `codex-reply`) and keeps its working context. Fresh context comes from starting a *new* task (no `resumeTaskId`), not from a Worker that dies after one turn.

How and when to restart a Worker for context reasons, and whether Workers share history across tasks, are deliberately left open for now (§15) — they depend on workflow we haven't validated yet.

**Intent in, strategy out.** The Orchestrator never picks Worker lifetime or chooses among near-duplicate tools. It states intent on one `delegate_task` call; the daemon picks the strategy.

A note on the word **"policy"** used below and elsewhere: it means the daemon's built-in decision logic — code, shipped with the defaults shown here. It is **not** a configuration language the operator authors or maintains. In v1 the only things configured are the repo registry (a short list, §3) and client tokens (§9); there are no policy files and no YAML to indent. If a default ever needs changing, that's a code change to the daemon, not a config surface.

| Field | Meaning | Example values |
|---|---|---|
| `target` | A repo to change, or a shell session on the host | `{repo: "youknowme"}` or `{shell: true}` |
| `deliveryMode` | How far to carry it | `research_only`, `patch`, `pr_for_review`, `full_delivery`, `push_to_main` |
| `risk` | Caller's risk hint (feeds model-tier limits, §10) | `low`, `standard`, `high` |
| `resumeTaskId` | Continue an existing task's thread; omit to start fresh | a task id |
| `modelTier` | Cost/capability hint | `cheap`, `standard`, `strong` |
| `prompt` | The instruction | free text |

`target` is one of two kinds: a **repo** (the Worker gets a worktree and changes code) or a **shell** (a Worker with host access and no repo, for ops/diagnostics/SSH). Both are detailed under "Targets" below.

Default behavior (built-in, per the note above):

- repo target, mutating mode (`patch`/`pr_for_review`/`full_delivery`/`push_to_main`) → task-scoped Worker, worktree, branch `fleet/<repo>/<taskShort>`.
- repo target, `research_only` → task-scoped Worker, optionally a read-only checkout (no branch).
- shell target → Worker with host shell access, no repo or worktree; actions logged.
- `resumeTaskId` present → continue that task's thread (same task, another turn).

(Any coarse task class the daemon needs for routing or audit is derived from `target` + `deliveryMode` — the Orchestrator does not label it.)

The daemon overrides intent only where it's cheap and safe: it makes the checkout read-only for `research_only`, and downgrades model tier only where the built-in rules allow. (Worktree isolation isn't an override — it's unconditional for repo work, §5.)

**`deliveryMode` is a soft signal to the Worker, not a security boundary.** It tells the Worker how far to carry the work, and the daemon uses it for one hard thing only — a read-only checkout for `research_only` (no branch). Beyond that, Codex Fleet does not enforce delivery limits: it will not try to stop a Worker from merging its own PR or running a deploy. That kind of prevention belongs at the sandbox and repo-permissions layer (a later epic, §9), not here. The Worker infers repo workflow from local docs (`AGENTS.md`, branch protection, CI config); the Orchestrator judges whether the target was met.

- **research_only / diagnostics** — return findings; no branch, no PR.
- **patch** — implement and verify locally; hand back a diff; don't push.
- **pr_for_review** — branch → implement → run checks → commit → push → open PR → **stop for human merge**.
- **full_delivery** — as above, then carry through merge when the prompt says to and repo norms allow; end on a clean, current main. (Nothing enforces this in v1 — it's an instruction, not a granted permission.)
- **push_to_main** — land directly on the main branch instead of via a reviewed PR: implement → check → commit → push to main. Agents run with the operator's credentials, so this works even on protected branches (they can merge or approve through the gh app); use it only where landing without review is the repo's norm.

This is conveyed through the Worker's instructions, not enforced: a tenacious Worker treats "fix it and follow the full process" as permission to merge unless told otherwise, so `pr_for_review` is the default when a repo's main branch is protected and merge/deploy authority is never implied in the prompt. Until real permission boundaries exist, this is the only lever — which is why it stays a default-safe instruction rather than a promise.

### Targets: a repo, or a shell

A task's `target` is one of two things, and neither is an arbitrary path the Orchestrator invents.

The **repo registry** is a configured list of the repositories the fleet may work in. Each entry has a short alias — for example, `youknowme` — that points to a real checkout on disk, plus what the daemon needs to run a task there: the default branch, whether that branch is protected, the commands that verify a change (build, test, lint), and a default model tier. (Environment setup is not here — the Worker handles that itself, §5.) The named checkout is a template only; the daemon never works in it directly — it cuts a fresh worktree from it for each task (§5). The registry replaces the POC's flat config of one worker per repo, and limits repo work to the listed repos rather than "anywhere."

The other target is a plain **shell** Worker: shell access to the host machine, no repo attached. This covers the open-ended cases a repo target can't — running an ops command, SSHing somewhere, or copying a secret into place without it passing through the Orchestrator's context or logs (eliminating the manual copy/paste step). v1 keeps shell as one broad category rather than a menu of access profiles; splitting it into finer-grained, least-privilege profiles is a later epic (§9). A shell Worker runs with the same broad access as repo Workers today.

`list_targets` returns the repo registry plus the shell target, so the Orchestrator can see what exists.

---

## 4. Public API

Small and hard to misuse. The POC's `send_task`, `start_task`, and `broadcast_task` are gone from the public surface; blocking calls survive only in local test scripts.

The surface is deliberately **backend-agnostic** — no tool, field, or return value names Codex. It speaks in tasks, targets, and Workers, never the engine behind them. That keeps the door open to other coding agents, or a different backend entirely, without changing anything the Orchestrator calls. "Codex" stays an implementation detail of the daemon and the Worker subprocess.

| Tool | Purpose | Returns |
|---|---|---|
| `initialize` | Declare a session name to group this Orchestrator's tasks | acceptance |
| `list_targets` | Discover available repos and the shell target, with model tiers | target descriptors |
| `delegate_task` | The one way to start work (intent fields, §3) | `{taskId}` immediately |
| `get_task` | Snapshot of one task | operational state, last activity, final output, owned resources |
| `wait_tasks` | Bounded multi-task wait (preferred waiting primitive) | event deltas + snapshots |
| `list_tasks` | Fleet overview, filterable | task rows |
| `get_task_history` | Recent prompt/response/event history | history records |
| `end_task` | Finish or cancel a task, and release its owned resources | acceptance |

One task-starting tool; modes are fields, not tools. And one task-ending tool: `end_task` is what the Orchestrator calls both to stop a running task and to say "I'm done with this finished one — let its worktree and logs go." The Orchestrator never manages individual resources or runs cleanup dry-runs; that's an operator/CLI concern (§7).

**What an Orchestrator sees is scoped to the caller.** `list_tasks`, `get_task`, and `get_task_history` show an Orchestrator its own tasks, not everything on the machine. The scoping key is `ownerSession`: the caller's client id (§9) plus an optional session name the Orchestrator declares (below). With a name, scoping uses the combination; without one, it falls back to client id alone.

**Specifying the session.** Kept deliberately simple: the Orchestrator calls `initialize(session)` once, early in its work, to declare a session name; tasks it then delegates are grouped under it. The name is the Orchestrator's to choose and reuse: after an Orchestrator restart mid-session, calling `initialize` again with the same name reattaches to the same session. (A startup-generated id couldn't do that; it would orphan the session on restart.) If `initialize` is never called, tasks fall back to client id alone — fine for a single operator. The human can rename a session in the UI (§8) at any time. Calling `initialize` early belongs in the skill file for this MCP server, so the Orchestrator does it by default.

**Waiting primitive.** Orchestrators impose tool-call timeouts and kill long calls while the Worker keeps going (the POC fell back to `sleep 44 && echo done`). Instead, wait in bounded, event-driven slices:

```
wait_tasks(taskIds[], sinceEventSeq?, maxWaitSeconds?, returnOnStatuses?)
```

The server caps `maxWaitSeconds` (~30–45s) and returns the instant any watched task has a new event or interesting status. The reply has three parts: a **snapshot** of each watched task (its current `get_task` fields — state, last activity, latest output), the **event deltas** since `sinceEventSeq` (what changed), and `suggestedNextWaitSeconds`. It never blocks until completion. The Orchestrator loops:

```
delegate A, B, C
loop:
  r = wait_tasks([A,B,C], sinceEventSeq, 30)
  handle r.changed
  until all terminal or blocked
```

**Progress, not just start and end.** The event deltas are where live progress shows up, and this is how the design addresses the POC's opacity. The daemon captures whatever the Worker emits while running — MCP progress/log notifications, streamed reasoning or output, tool-call activity — and appends it to the task's event log. So the loop above is really: wait a slice, print the new event lines as a status update, resume. The human (or Orchestrator) finally sees what a Worker is doing *between* start and finish, instead of guessing.

How rich this is depends on what the Codex MCP server actually emits mid-run, which we still need to confirm (§15). The design degrades gracefully: if a Worker emits nothing until it finishes, `wait_tasks` still returns liveness — process alive and seconds-since-last-activity — so a quiet Worker reads as "working," not "hung."

A CLI waiter (`codex-fleet watch <id...> --any --json`, like `gh run watch`) reads the same event state — a view, not a second state model.

**Teaching errors.** When the Orchestrator picks wrong, errors name the correct next call: a removed blocking tool points to `delegate_task` + `wait_tasks`; an unknown repo alias returns the current `list_targets` set; a bad `taskId` says how to find live tasks.

---

## 5. Worktree isolation

Required for safe parallel work — the POC hit `.git/index.lock` contention when an Orchestrator and a Worker, and a manual session and a Worker, shared a checkout.

- Every repo-mutating task creates an isolated worktree before any edit or git operation. The base checkout is never the workspace.
- Branch names derive from task id + repo alias (`fleet/<repo>/<taskShort>`).
- Isolation is unconditional, so the operator's own manual checkout of a repo is never touched: Workers always work in a fleet-created worktree, never the base checkout.
- The Worker readies the fresh worktree itself — see below.

### Worktree bootstrap — the Worker does it

A `git worktree` shares the repo's history but **not** the things that live outside version control, and those are exactly what a Worker needs to run: tool trust (`mise trust`, `direnv allow`), activated tool versions, installed dependencies (`node_modules`, a virtualenv), uncommitted env files, git hooks, codegen. Something has to set these up in each fresh worktree.

For v1 that something is the **Worker**, not the daemon. Two reasons it's the simpler choice: every repo already carries an `AGENTS.md` describing how to get it ready, and Workers read it; and a Worker has full shell access, so there's almost nothing it can't run itself. Pushing setup into daemon config would duplicate, in the fleet, knowledge that already lives in the repo — and keeping the daemon thin matters more here than saving the Worker a few setup turns.

The fleet's only contribution is a **generic preamble** injected into every Worker's instructions (alongside its name, repo path, and worktree path): *"You're in a fresh git worktree at `<path>`. Before working, make the environment ready per `AGENTS.md`; if a tool reports 'not trusted,' trust it for this path."* That's one reusable instruction — no per-repo bootstrap config, no DSL, no auto-detection.

The accepted trade-offs: a Worker spends a few turns/tokens on setup, and a careless one could skip a step — caught by the repo's own verify commands before delivery. Deterministic pre-staging by the daemon (placing a secret the Worker can't access, or a step that must run before the Worker's first action) is a deliberate **later** escape hatch, not a v1 feature.

One thing to verify early (§15): whether a fresh-worktree `mise`/`direnv` trust prompt *hard-blocks* the Worker's first command non-interactively. If it merely warns, the preamble is enough; if it blocks, that single trust step may need to be the first daemon pre-stage we add.

---

## 6. Operational state — not semantic completion

Codex Fleet does **not** decide whether a task is "done" in the product sense — whether a PR is sufficient, CI is acceptable, or a deploy is complete. That's the Orchestrator's job. Inferring "done" from PRs/CI/containers would make Codex Fleet a second Orchestrator and a brittle workflow engine. It reports only what it observes:

- task created;
- Worker process started (or failed to start);
- Worker alive or exited (with exit code when available);
- last-activity timestamp;
- final output, if the Worker produced one;
- timeout / cancellation / failure-to-start;
- resources the task created (§7).

**Task states:**

```
queued · running · exited · failed_to_start · cancelled · timed_out · stale
```

`stale` means running but no observed activity for a configured interval — a signal to look, not a failure. If the Worker exits without a final output, that fact is reported. There is no reported-vs-reconciled split and no completion checklist.

**External artifacts are not ownership truth (v1).** PRs, CI runs, deployments, containers, and issues may appear in Worker output but are not tracked as state. They live in systems that already know their own truth; the Orchestrator can read those directly. This boundary can move later — a specific signal like "is this PR merged" could become an explicit owned check — but the default is to stay out of semantic completion.

---

## 7. Cleanup

**A Worker exiting does not trigger cleanup.** The Worker process ending just moves the task to `exited`; the worktree stays. This is the §6 stance applied to cleanup — the Orchestrator owns completion, and it (or the operator) often wants to inspect the diff, branch, or output *after* the Worker is done. Resources are released only when the Orchestrator calls `end_task` ("I'm done looking") or a TTL reclaims an abandoned task. Releasing on exit would throw away exactly the context worth inspecting.

When release does happen, it's almost as simple as deleting the directory the Worker was pointed at. Three things make it slightly more than a bare `rm -rf`:

1. **It's a git worktree, not a plain tmp dir.** Use `git worktree remove` (and `prune` when needed). A bare `rm -rf` leaves git's worktree registration behind and can keep the task branch "checked out," blocking reuse later.
2. **Don't delete it while it's in use, or before release.** Only after the task is terminal, no Worker process for it is alive, and `end_task` or a TTL has released it — otherwise it would nuke active or still-wanted work.
3. **Don't silently lose uncommitted work.** If the worktree is dirty (a failed task left an unpushed diff), the daemon reports it instead of deleting:

```
cleanup_blocked_dirty
worktree:    ~/.codex-fleet/worktrees/youknowme/abc123
dirty files: 3
action:      inspect | archive_patch | force_cleanup
```

The task's other leftovers are just separate objects with their own timing: the **branch** is deleted once it's merged or has no unpushed commits; the **logs** (`~/.codex-fleet/tasks/<id>/`) are kept after the worktree is gone, since they're the observability record, and pruned on their own schedule. Cleanup only ever touches things the fleet created — never the operator's own checkouts (§5) and never external artifacts like PRs.

**Who triggers it.** The Orchestrator, by calling `end_task` when it's finished with a task; or a TTL that reclaims tasks left `exited` and untouched for too long. Orphans neither path caught — a Worker that died mid-task, a dirty worktree, a stale `.git/index.lock` (removed only when no git process owns it) — are an *operator* concern: the CLI lists them and offers a cleanup command with **dry-run** output to preview before deleting. None of this is on the Orchestrator's API beyond `end_task`.

---

## 8. Observability

The POC forced the human to reconstruct truth from Orchestrator narration, GitHub, local git, logs, and `ps`. The product needs a task-aware view that makes truth visible live.

This section is the **read-only view**, not a command center. Acting on the fleet happens elsewhere — the MCP API (`delegate_task`, `end_task`, §4) and the operator CLI (cleanup, §7). The dashboard's one write affordance is naming sessions (below); everything else here just shows what's true.

A terminal multiplexer isn't enough — it shows process output but not the task model (id, prompt, target, worktree, branch, owned resources, state). This view is codex-fleet-native and reads daemon state. It surfaces operational facts only: if a Worker's output mentions a PR, that text is shown, but the dashboard does not assert the PR's status as truth.

**First version (read-only):**

- fleet summary: queued / running / stale / exited / cleanup-pending counts;
- one row per task, grouped by session (§4), showing target, state, and last activity;
- task detail: target, session, state, branch/worktree, owned resources, last output, event timeline;
- no destructive actions.

```
session: nightly-refactor                              3 tasks
  a1b2c3  repo youknowme   RUNNING   testing · 12s ago
  77f0e1  repo ykmcorpus   EXITED    exit 0 · awaiting end_task
  389ccd  shell            RUNNING   deploy step 2/5 · 4s ago

Task a1b2c3
  Target:   repo youknowme
  Session:  nightly-refactor
  State:    running              Started: 05:27:58Z
  Worktree: ~/.codex-fleet/worktrees/youknowme/a1b2c3
  Branch:   fleet/youknowme/a1b2c3
  Process:  pid 12345 alive      Last activity: 12s ago
  Last output: "opened PR #51; CI pending"   (worker's words, not verified)
```

The dashboard renders the §6 states plus a `cleanup-pending`/`cleaned` marker — no inferred phases like `opening-pr`, since Codex Fleet doesn't observe those.

**Session naming** is the one place the dashboard goes beyond read-only. Tasks arrive grouped by `ownerSession` (§4); a session the Orchestrator didn't name shows up as an unnamed group keyed by client id. The human can name or rename it so the fleet view reads meaningfully. This is the operator backstop for when the Orchestrator hasn't called `initialize`.

**Usage measures.** Alongside live state, the dashboard shows simple aggregate counters describing how the fleet is actually being used. These are free — just queries over the durable task store and event log (§11, §12), no new instrumentation:

- totals: tasks delegated, tasks by terminal state (`exited` / `failed_to_start` / `cancelled` / `timed_out`), sessions seen, repos touched;
- right now: active Workers, running vs queued tasks, peak concurrent Workers;
- over time: tasks per day, and per repo and per session;
- durations: median and longest task runtime.

These are counts of operational facts, nothing interpreted. They double as a health signal — a climbing `failed_to_start` rate or `timed_out` count is an early sign something's wrong.

**The TUI is part of v1, not optional polish** — making fleet activity visible is a primary goal. It is built with **OpenTUI** (TypeScript bindings over a Zig rendering core; React-style front-end), chosen because it keeps us in one language while handling a live, busy fleet view, and because it already runs a similar workload (OpenCode's terminal UI). It is a separate process reading the daemon's RPC/event stream, so the choice is decoupled from the daemon and reversible if OpenTUI's pre-1.0 churn becomes painful (fallback: bubbletea, over the same socket).

Build order within observability: the CLI `status`/`watch` lands first (cheap, right after the daemon), the TUI grows alongside the Phase 3 event stream, since a rich live view needs those events to show anything. cmux/herdr are not the dashboard; they're only ever considered later as optional pane *surfaces* driven by daemon state, adopted only if they can carry codex-fleet task metadata rather than terminal heuristics.

---

## 9. Security

Dangerous by design: a Worker with `danger-full-access`, no approval prompts, SSH keys, Docker, GitHub creds, and deploy scripts can do real damage. The POC broker was at least not a listening service; a daemon adds a privileged local endpoint that needs deliberate auth.

**v1 authn — local three-layer trust** (full version in `docs/v1-authn.md`):

1. **OS user identity** gates filesystem/socket access. The adapter runs as the operator's user account, so only that account can traverse `~/.codex-fleet`, read the token, and open the socket. Other users are blocked before token auth matters.
2. **Capability token** gives the daemon a client identity and its **scopes** — the set of operations that token is allowed to call. For example: an Orchestrator token can `delegate`/`wait`/`get`/`end_task`; a dashboard token is read-only (`list`/`get`); a CLI token adds `cleanup`. Scopes are how a read-only viewer can't accidentally start or kill work.
3. **The daemon allows a call only if the token's scopes include it** — otherwise it's rejected and audited.

```
~/.codex-fleet/                 0700
  daemon.sock                   (Unix socket, no TCP by default)
  clients/<clientId>/token      0600
```

The client id is a non-secret label; the token is the secret. The daemon stores only `sha256(token)` plus scopes and `revoked_at`. Client config holds no secret — the adapter launches with `--client-id claudecowork`, reads the token at runtime, and presents `{clientId, token}`. **Out of scope:** same-user or root compromise (code already running as the operator's account can reach SSH keys, creds, and repos anyway).

**Optional hardening (v1.x).** Not needed for the first cut, but cheap to add later:

- **Verify the socket peer UID.** When a process connects to the Unix socket, the OS can tell the daemon which user owns that process (`SO_PEERCRED` / `LOCAL_PEERCRED`). The daemon checks it's the operator's user account and rejects anything else — a backstop in case the socket's file permissions are ever misconfigured, so only the operator's own processes are served even then.
- **Token rotation with `revoked_at`.** A way to issue a fresh token and mark an old one revoked (the daemon already stores `revoked_at`), so a leaked token can be invalidated on its own instead of rebuilding everything.
- **Per-request audit line.** One log line per request — who called, which tool, when — so privileged actions can be reconstructed after the fact.

And a standing rule, not optional: **never run the daemon as root.** It runs as a normal user account; root would hand a compromise the run of the whole machine instead of just what that account can already reach.

**Toward least privilege.** Near-term, Workers run YOLO-equivalent (`danger-full-access` + `approvalPolicy: never`) because the fleet's value is Workers running tests, git, Docker, SSH, and deploy checks without escalating every decision. That's the useful default, not the end state. The path forward: split the one broad shell category into finer-grained, least-privilege access profiles; human gates for merge/deploy/prod-SSH/secrets; per-task risk classification; secrets redaction; allow/deny policy for commands/paths/network/credentials; a fleet kill switch; credential scoping/rotation; sandboxed isolation for untrusted code (optionally via `gh-agent-broker` containers for repo-centric GitHub work — though host-specific work like local Docker staging and prod SSH would still run as shell Workers).

---

## 10. Model-tier routing

The daemon controls Worker launch, so it can route tasks to different Codex models for cost and throughput. The Orchestrator requests a tier (`cheap | standard | strong`); the daemon enforces limits so a cheap model is never used where the rules forbid it — e.g. `risk: high`, or a delivery mode that merges or deploys (`full_delivery` / `push_to_main`).

- a task may request an optional model tier;
- `list_targets` advertises the available tiers and which is the default;
- the daemon keys cheaper-model eligibility off `target` + `deliveryMode` (e.g. low-risk `research_only`), not an Orchestrator-supplied class;
- logs record requested vs actual model;
- fallback is explicit when a requested tier is unavailable.

---

## 11. Logging

First-class JSONL, one record per task event: task id, target, prompt preview, response preview, operational state, timestamps, duration, Codex thread id, error, tool/client version, daemon instance id. **Previews (truncated) are always kept; full prompts and full responses stay opt-in** — SSH and deploy output may contain secrets — and when retained they're stored as separate payloads the task points to (`promptRef`/`finalResponseRef`, §12), not inlined. The TUI and CLI consume this same stream, so logs are the durable spine of task state, not an after-the-fact artifact.

---

## 12. Data model

The daemon persists state across restarts. The durable substrate is the **append-only event log** (the same JSONL we need for §11): every state change is an appended event, and on startup the daemon replays the log to rebuild current task state in memory. A small per-task snapshot file is optional for quick reads and `cat`-level inspection. No database is required for v1 — at a single operator's volume, `list_tasks` and the §8 usage counts are just scans over data already in memory.

SQLite is a reasonable later upgrade, not a v1 requirement. It buys two things: crash-safe atomic writes (a transaction won't leave half-written state) and cheap filtered/aggregate queries — so it mostly replaces durability and reporting code that would otherwise be hand-rolled. Adopt it when reporting or volume makes scans annoying; until then, plain files keep v1 simple and inspectable.

```
Task
  id, createdAt, updatedAt
  target           {repo: alias} | {shell: true}
  deliveryMode, risk, modelTier
  resumeTaskId?
  promptPreview    (truncated; full prompt only when retention is on)
  promptRef?       (pointer to full prompt payload, if retained)
  state            (queued|running|exited|failed_to_start|cancelled|timed_out|stale, §6)
  exitCode?
  finalResponsePreview?  (worker's last output, truncated — stored, not interpreted)
  finalResponseRef?      (pointer to full output, if retained)
  lastActivityAt
  worktreePath?, branch?
  workerProcessId?, codexThreadId?
  requestedModel, actualModel
  ownerSession     (client id + optional session name declared via initialize)

Event   (append-only, per task)
  taskId, seq, ts, type, summary, payloadRef?

Repo
  alias, baseCheckout, defaultBranch, branchProtected?, verifyCommands[],
  defaultModelTier
  (no bootstrap config in v1 — the Worker self-bootstraps, §5)

(v1 has no capability/profile schema — a shell target is just "Worker with host
access," not a configured record. Finer-grained access profiles are a §9 future.)

Resource (what a task created, for cleanup + the operator orphan list)
  taskId, kind (worktree|branch|process|lock|patch),
  path/ref, createdAt, completedAt

Client/token
  callerId, role/permissions, tokenHash
```

Event `seq` is the cursor `wait_tasks` uses for deltas.

---

## 13. Stack and project layout

**Stack.** TypeScript throughout, on **Bun** as the preferred single runtime (not a hard requirement — if the MCP SDK misbehaves under Bun, the daemon and adapter fall back to Node; the socket seam means a mixed runtime is harmless). TypeScript is dictated by the daemon needing a mature MCP *client* and by reusing the working POC. One language means shared types across daemon, adapter, CLI, and TUI. The **TUI uses OpenTUI** (§8). Validate the Bun runtime up front with a focused spike (§14) before building on it; if any piece fights back, the daemon and adapter fall back to Node while the TUI stays Bun/OpenTUI.

```
codex-fleet/
  packages/
    daemon/          persistent process; source of truth
      src/
        store/       append-only jsonl event log + state replay (sqlite optional later)
        scheduler/   queue, intent→strategy rules, concurrency
        workers/     codex mcp-server lifecycle, access, model tiers
        supervisor/  liveness, activity/stale detection, exit capture
        worktree/    create/cleanup, lock handling
        registry/    repo list (shell is a built-in target)
        rpc/         unix-socket server, authn/authz, audit
    mcp-adapter/     thin stdio MCP server → daemon RPC; exposes §4 tools
    cli/             codex-fleet {list,delegate,status,logs,watch,cleanup}
    tui/             read-only dashboard over daemon RPC (OpenTUI)
    shared/          types, zod schemas, RPC contract, event types
  test/
    schema/          MCP output schemas vs Claude-strict behavior
    integration/     daemon + fake codex worker end-to-end
  docs/              DESIGN.md · LEARNINGS.md · API.md · v1-authn.md
```

A monorepo keeps the RPC contract and shared types in one place; adapter, CLI, and TUI are all thin clients of the daemon.

---

## 14. Phased delivery

Each phase is independently useful and de-risks the next.

**Before Phase 1 — Bun runtime spike.** Bun is the preferred runtime (§13), but don't let that become the first hard problem. Prove these in the new repo before building anything on Bun; if any fights back, fall back to Node for the daemon and adapter — the TUI can still be Bun/OpenTUI, since the socket seam makes a split runtime harmless:

- the MCP stdio adapter runs reliably under Bun;
- Bun can spawn and supervise `codex mcp-server` subprocesses;
- Unix-domain-socket RPC (server + client) works under Bun;
- append-only JSONL writes are durable enough (flush/fsync behavior);
- Zod schema validation behaves as expected;
- Claude/Cowork can launch the Bun-built adapter as an MCP server.

**Phase 1 — Daemon + thin adapter (with minimal auth).** Daemon with Unix-socket RPC; task state and threads moved into it, durable via the append-only event log (state rebuilt on restart); adapter becomes a stateless proxy. The endpoint is privileged from day one, so the v1 authn baseline ships here: socket under a `0700` dir, per-client token, scopes, and a per-request audit line (§9). *Acceptance:* restart the adapter mid-task, `get_task` still correct; a token without the right scope is rejected and audited.

**Phase 2 — Isolation + task-scoped Workers.** Per-task worktrees/branches, the generic self-bootstrap preamble injected into Workers, task-scoped lifecycle as the repo-mutating default. *Acceptance:* two tasks on one repo run in parallel without lock contention; a manual session is never touched; a Worker readies a fresh worktree from `AGENTS.md` without manual help.

**Phase 3 — `wait_tasks` + supervision.** Bounded waiting plus operational-state tracking (liveness, stale detection, exit/final-output capture). *Acceptance:* a Worker that exits without reporting shows `exited` + exit code; one that goes quiet is `stale`, not failed.

**Phase 4 — Cleanup.** Release a task's worktree (`git worktree remove`) on `end_task` or TTL — not on Worker exit — plus operator/CLI cleanup of orphans (`list_cleanup_candidates` + a dry-run cleanup command) with dirty-worktree quarantine.

**Phase 5 — Observability.** Read-only CLI `status`/`watch`, then the native OpenTUI dashboard. cmux/herdr only considered afterward, as optional pane surfaces.

**Phase 6 — Advanced security & routing.** Building on the Phase 1 auth baseline: finer-grained shell access profiles (splitting the one broad shell category); human gates for merge/deploy/secrets; model-tier enforcement; token rotation and the other §9 hardening items.

Phases 1–3 deliver trustworthy infra; 4–6 make it safe to grow.

---

## 15. Decisions and open questions

**Resolved:**

- A Worker is scoped to a task, not a repo. A task is an operational envelope, not a semantic unit. The Orchestrator sends intent; policy decides.
- A task can be multi-turn (the Orchestrator continues a Worker's thread); fresh context comes from a new task.
- `wait_tasks` is the preferred waiting primitive; `get_task` is a snapshot; the CLI watcher is a view.
- Unix domain socket by default; TCP opt-in only.
- One `delegate_task`; no public blocking or near-duplicate tools.
- Daemon reports operational facts only; the Orchestrator owns semantic completion. No "done" inference from PRs/CI/deploys in v1.
- Stack: TypeScript on Bun (preferred single runtime; Node fallback for daemon/adapter if needed). A native TUI is committed, built with OpenTUI; cmux/herdr are only optional later pane surfaces (§8, §13).

**Open — to learn by running it, not designed yet:**

- **When to restart a Worker for context reasons.** The Codex harness can't report context usage, and asking the Worker is unreliable. For now restart is the human's/Orchestrator's call; the daemon only makes restart cheap and observable. Don't automate a trigger yet.
- **Whether a handoff document is used at all.** The manual `agent-handoff.md` pattern is fragile and often dropped in maintenance. If we keep something like it, it must **not** live in the repo — parallel worktrees would guarantee merge conflicts. A candidate is a daemon-held note store, scoped per (Orchestrator × repo-or-shell shape) and kept outside the repo, so Workers of the same shape share recent history. Unproven; build only after experimenting.
- **How the Orchestrator's "what to do next" relates to a Worker's "what's been done."** These may be separate memories or one; unclear until we run real multi-task work.
- Task visibility scoping is by `ownerSession` — a name the Orchestrator declares via `initialize`, reused across restarts (§4). Voluntary and cooperative, which is fine for a single operator; revisit only if multi-user.
- What does the Codex MCP server emit *while* a task runs — progress/log notifications, streamed output, tool activity? Determines how rich `wait_tasks` progress can be; if it emits little, the fallback is liveness/last-activity (§4). Worth verifying early, since live progress is the main fix for POC opacity.
- Does a fresh-worktree `mise`/`direnv` trust prompt hard-block a Worker's first command non-interactively, or just warn? If it blocks, the self-bootstrap preamble (§5) isn't enough and that one trust step becomes the first daemon pre-stage.
- How long can multiple local ChatGPT-authenticated Codex sessions run before throttling? (caps fleet width)
- Per-repo concurrency: one at a time, or multiple threads with distinct worktrees?
- Thread continuity: `resumeTaskId` only, or also named conversation handles?
- Cancellation: cooperative-only, or hard kill + cleanup for stuck Workers?
- Does the daemon ever need an HTTP API, or is the Unix socket enough?
- Will Bun cleanly run the daemon/adapter (MCP SDK, subprocess supervision, Unix-socket RPC, JSONL durability, Zod)? Settled by the pre-Phase-1 spike (§14); if not, daemon/adapter fall back to Node while the TUI stays Bun.

---

## Appendix — Lesson → design

| LEARNINGS lesson | Addressed in |
|---|---|
| Client-owned MCP lifetime loses state | §2 three tiers, §14 Phase 1 |
| Near-duplicate task tools confuse Orchestrator | §4 single `delegate_task`, teaching errors |
| Blocking calls time out; `sleep 44` fallback | §4 `wait_tasks` + CLI watcher |
| Same-checkout `.git/index.lock` collisions | §5 isolation, §14 Phase 2 |
| Worker did work but never reported done | §6 operational state |
| mise "config not trusted" in fresh worktree | §5 self-bootstrap preamble |
| Dirty worktrees / dead branches / stale locks | §7 cleanup |
| Human guessing what fleet is doing | §8 observability |
| Privileged YOLO Workers are dangerous | §9 security |
| Cost control across tasks | §10 model-tier routing |
| Sensitive data in logs | §11 opt-in full prompts/responses |
| Definition of done / Worker tenacity | §3 delivery modes |
