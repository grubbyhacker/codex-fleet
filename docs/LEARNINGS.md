# Codex Fleet POC Learnings

Date: 2026-06-12

## Outcome

The POC proved the core idea is valuable: Claude Cowork can delegate useful work to named Codex workers over MCP, including repo inspection, SSH diagnostics, code edits, commits, and pushes. The workers used the local Codex CLI path authenticated with ChatGPT, not direct OpenAI API calls.

Most important validation: multiple PRs were created and merged without direct human implementation. The orchestrator and workers discussed, proposed, built, verified, and delivered changes agent-to-agent while the human stayed mostly out of the loop.

## What Worked

- One broker MCP server can expose several named repo-specific Codex workers.
- Each worker can run a native `codex mcp-server` subprocess in its own repo cwd.
- The orchestrator can call `list_clients` to discover worker names, cwd, capabilities, sandbox mode, and approval policy.
- Worker identity and capability text matter; Cowork uses those descriptions to route tasks.
- `danger-full-access` plus `approvalPolicy: never` is the practical MCP equivalent of YOLO mode for Codex sessions.
- Cowork successfully delegated real work:
  - `vps_ops_agent` ran SSH diagnostics against `hermes-vps`.
  - `vps_ops_agent` committed and pushed `bbdd065`.
  - `youknowme_coding_agent` investigated startup behavior in the YouKnowMe repo.
- JSONL logs are useful enough to reconstruct delegation behavior and timing.

## What Broke

- Blocking calls are fragile. Claude/Cowork can time out or restart the MCP server while `send_task` is waiting.
- Having multiple task-starting tools confused the orchestrator. `send_task`, `start_task`, and `delegate_task` are too similar.
- Async tools initially had schema mismatch bugs. Claude was stricter than local SDK smoke tests: structured output must match declared output schema exactly.
- Stdio MCP server lifetime is controlled by the client. If Claude restarts or reconnects the MCP server, in-memory task state and active worker connections can be lost.
- Duplicate broker processes appeared during Desktop/Cowork reconnects and Claude Code health checks.
- Background tasks inside the stdio MCP process are not durable enough for real work.

## Product API Direction

The public MCP surface should be small and hard to misuse:

- `list_clients`
- `delegate_task`
- `get_task`
- `list_tasks`
- `get_client_history`
- `reset_client_thread`

`delegate_task` should be the only public way to start work. It should always return quickly with a `taskId`. `get_task` should be the only way to retrieve status and results.

Do not expose blocking `send_task` to orchestrating agents in the final product. Keep blocking behavior only in local test scripts.

## Orchestrator Behavior

The orchestrator model and initial prompt matter. This POC used Claude Cowork on Sonnet 4.6 to save tokens, after a long interactive setup with a lot of copy/paste and changing instructions. That is not the cleanest test of the orchestration pattern.

A better E2E test should start with a stronger model and an explicit orchestration brief from the first turn:

```text
You are an orchestrator. Your job is to coordinate a fleet of Codex worker agents through the codex-fleet MCP server.

First, call list_clients to discover available workers and their capabilities.

For any real work, delegate to workers with delegate_task. Do not use send_task. Poll get_task until each delegated task is completed or failed.

Prefer delegation over asking the user to drive step-by-step. Be independent, stay on task, and keep the user informed with concise status updates.

When delegating coding work, specify the desired delivery mode:
- research/diagnostics only
- patch only
- PR and stop for review
- full delivery through merge
- direct push to main where repo norms allow it

Do not merge or deploy unless the task explicitly grants that authority.
```

The orchestrator should treat worker agents as its first-line execution layer, not as a fallback after exhausting its own context. The value proposition is freeing the orchestrator to coordinate, synthesize, and decide while workers spend context on repo-specific execution.

## Worker Tenacity

Worker agents need a stronger default definition of done. For mature repos with protected branches and clear `AGENTS.md` methodology, a delegated coding task should normally be carried all the way through the repo's delivery path, not stop at a patch.

For protected-branch repos, the expected lifecycle is:

- start from a clean and current working tree
- update from the main branch
- create a feature branch
- implement the requested change
- run the repo's prescribed checks and presubmits
- commit the work
- push the branch
- open a PR
- monitor CI/presubmits
- address failures or review feedback when possible
- wait for human merge when required
- after merge, return only once the local checkout is back on main and current

For repos without branch protection, the expected lifecycle may be simpler:

- start clean and current
- implement the change
- run the appropriate checks
- commit
- push directly to main when that is the repo norm
- confirm local main is current

Not every delegated task is a coding task. Diagnostics, research, audits, and planning tasks should return findings without forcing a branch/PR workflow. The orchestrator should communicate the task mode clearly, and the worker should infer the repo workflow from local docs such as `AGENTS.md`, branch protection conventions, CI configuration, and existing contribution patterns.

This should become explicit orchestration guidance: when delegating a feature or fix, ask for a durable delivery outcome, not just code edits.

There is a matching control requirement: if the orchestrator wants human review before merge or deploy, the prompt must say so explicitly. Otherwise a tenacious worker may treat "fix the root cause and follow the full delivery process" as permission to open, merge, and complete the PR without stopping for another human checkpoint.

Another observed failure mode: the worker can complete the real-world side effect but fail to report completion back to the broker. Example: an `agent-broker` task rsynced the production YouKnowMe index to local staging and brought up a healthy local `youknowme-phase1e` container, but the broker had no `task_finished` event. The system needs reconciliation: task state should be validated from durable artifacts, process state, git state, PR state, container health, or explicit worker heartbeat, not only from final model response.

Another concurrency failure mode: two agents can touch the same checkout at the same time. This happened when the orchestrator made file changes, realized the mistake, and then delegated to a fleet worker; git lock files and overlapping filesystem edits blocked one or both agents. It also happened when a manual Codex session was already working in the YouKnowMe repo while Cowork delegated to the configured `youknowme_coding_agent`, causing both agents to share the same repo path.

Fleet workers need checkout isolation. A delegated repo task should not run directly in the user's normal working copy unless explicitly requested. The default should be a separate git worktree per task, with a branch name derived from the task id and worker/repo alias. This avoids `.git/index.lock` contention, protects the user's manual session, and makes cleanup/reconciliation easier.

Worktree setup has repo-tooling gotchas. A fresh task worktree may not inherit local trust state from the base checkout. In particular, `mise` can halt with a "config not trusted" error in a newly created worktree until `mise trust` is run for that path. Worker instructions and eventually the daemon worktree bootstrap should handle this up front for repos that use mise, instead of leaving the worker blocked mid-task.

## Cleanup And Ownership

The platform needs explicit cleanup ownership. Dirty worktrees, abandoned `AGENTS.md` edits, dead branches, stale git lock files, half-created worktrees, and stopped agents should not accumulate indefinitely or block later tasks. This showed up when an orchestrator started making local edits, then switched to delegation without gracefully cleaning up, and when worker/manual sessions shared the same checkout.

The daemon should treat every task-created branch, worktree, process, and temporary artifact as owned resources with lifecycle metadata:

- owner task id
- worker or capability profile
- repo alias and base checkout
- worktree path
- branch name
- process/session ids
- PR URL when one exists
- created/last-active/completed timestamps
- cleanup policy

Cleanup should be reference-counted or lease-based. If no active task, worker process, open PR, or attached human session references a task worktree, the platform should be able to classify it as cleanable. Cleanup must be conservative around uncommitted changes: report and quarantine them rather than deleting blindly.

Needed cleanup behaviors:

- detect dirty task worktrees and report the diff summary
- remove stale `.git/index.lock` files only when no git process owns them
- prune task worktrees whose branches were merged and whose local state is clean
- after a merged task, remove the task worktree so it does not keep `main` or a feature branch checked out and block normal checkout operations elsewhere
- flag unpushed commits or untracked files before removal
- optionally archive patches from abandoned worktrees
- delete local task branches after merge when safe
- surface stale resources in `list_tasks`, `list_workers`, or a dedicated `list_cleanup_candidates`
- expose an explicit `cleanup_task` or `cleanup_resource` operation with dry-run output

Human/manual checkouts should be treated as external resources. The platform should avoid mutating or cleaning them unless the user explicitly opts in.

## Architecture Direction

The final product should split the current broker into two pieces:

```text
Claude/Cowork MCP stdio adapter
        -> local persistent codex-fleet daemon
              -> long-lived Codex worker MCP processes
```

The daemon should own:

- worker subprocesses
- task queue
- task state
- active Codex thread ids
- logs
- cancellation/retry behavior
- task-created worktrees, branches, and cleanup leases

The MCP stdio adapter should be thin and reconnectable. If Claude restarts the adapter, the daemon should keep running and `get_task` should still work.

There is an open architectural choice around worker lifetime. The POC started with "one long-lived worker per repo" because that matches the current manual workflow of keeping 2-3 terminals open, each running Codex in a different repo. That may not be the best final model.

Manual Codex usage has revealed a recurring pattern: ask an agent to persist its plan or update a handoff document, then restart it in YOLO mode with clean context to execute the plan. Long-lived codex-fleet workers do not naturally support this; they accumulate hidden context and are only restarted when the MCP client or broker is restarted. The platform should make "fresh execution from a durable handoff" a built-in lifecycle pattern.

An alternative is to separate repos, workers, and tasks:

```text
repo registry
    -> task request chooses repo + delivery mode
        -> daemon creates an ephemeral worker
            -> worker gets its own git worktree/branch
            -> worker exits when task is done
```

In that model, workers are not named long-lived agents. They are per-task execution slots. The repo is selected by the tool call or by a stable repo alias, and the daemon spools one Codex worker per delegated task. If two tasks are delegated to the same repo, they get separate worktrees and branches.

The likely default should be task-based ephemeral workers:

```text
delegate_task
    -> create durable task record
    -> create isolated worktree/branch when repo-scoped
    -> launch a fresh Codex MCP server for this task
    -> optionally run planning/handoff phase
    -> optionally restart fresh in YOLO execution phase using the saved plan
    -> collect results, commits, PRs, logs, and verification
    -> stop worker process
    -> cleanup or quarantine owned artifacts
```

Long-lived collaborators should remain possible, but as an explicit mode for exploratory work, continuity-heavy investigation, or interactive pairing. They should not be the default for repo-mutating delegated tasks.

The mature design should not expose "ephemeral versus persistent" as the orchestrator's primary decision. The orchestrator should express intent and context, and daemon policy should choose the execution strategy. Useful task fields may include `taskType`, `deliveryMode`, `risk`, `requiresRepoMutation`, `continuity`, `resumeTaskId`, and `target`.

Examples:

- `code_change` plus repo mutation -> ephemeral worker with isolated worktree
- `diagnostics` with no mutation -> ephemeral or shared read-only worker
- `resumeTaskId` present -> continue that task's saved context or handoff
- `exploration` plus explicit persistent continuity -> long-lived collaborator
- production/ops access -> audited capability-scoped worker
- simple issue triage -> cheap ephemeral model, no worktree
- broad multi-hour investigation -> persistent session or task with periodic handoff snapshots

This leaves room for policy and heuristics: force isolation when the base repo is dirty or manually active, summarize/restart when context gets too large, pause on risk escalation, or switch model/profile when task complexity changes.

The worktree idea is no longer only an architectural preference; it is required for safe parallel operation. Even if long-lived named workers remain available, repo-mutating delegated tasks should acquire or create an isolated worktree before editing, committing, or running git operations. Shared base checkouts should be treated as registries/templates, not as active task workspaces.

Not all tasks are repo-centric. Some delegated work is about using a different access profile: SSH to production, inspect logs, run an operational diagnostic, query local services, or use host capabilities unavailable to the orchestrator. This is an important part of the value proposition: the orchestrator can remain sandboxed and high-level while delegating privileged or environment-specific execution to workers with the right access profile.

The final product should support both:

- repo-scoped tasks: choose a repo, create/use a worktree, produce code/PR/delivery outcome
- capability-scoped tasks: choose an execution profile such as production SSH, Docker staging, local diagnostics, or ops scripts, with or without a repo

Benefits of per-task workers:

- no hidden long-lived conversational state unless explicitly requested
- cleaner isolation between tasks
- easier cancellation and cleanup
- parallel work in the same repo is possible with distinct worktrees
- task logs map directly to worker lifecycle
- fewer stale worker connections after MCP client restarts

Costs and risks:

- less ambient repo context carried between tasks
- more startup overhead
- more branch/worktree management
- merge collisions when many tasks touch the same area
- stronger need for PR/CI/merge queue discipline
- cleanup of stale task worktrees and branches after cancellation or failure

If GitHub merge queues or merge trains are available, they may help smooth collisions for repos with frequent parallel task branches.

## Orchestrator Tool Choice

Do not rely on orchestrating agents to choose correctly among similar tools or endpoints. This POC already showed that "choice" can be counterproductive: agents may blindly use an available MCP tool even when a better one exists for the task, or choose between similar options for reasons that do not match the platform's design intent.

The API should encode the preferred path:

- one default delegation tool for normal work
- explicit task mode fields instead of separate near-duplicate tools
- daemon policy decides ephemeral versus persistent worker when possible
- long-lived collaborator mode requires an explicit opt-in field and reason
- dangerous modes require explicit task classification and policy checks
- returned errors should teach the correct next call when the orchestrator chooses badly

Suggested default:

- repo-mutating coding task -> ephemeral task worker with isolated worktree
- diagnostics/read-only repo task -> ephemeral worker unless continuation is requested
- production/ops capability task -> capability-scoped ephemeral worker with audit logging
- exploratory collaboration -> explicitly requested persistent session
- continue prior investigation -> resume by task id or named session, not by guessing a worker

Skills, orchestrator prompts, and MCP server instructions can help, but they should reinforce platform defaults rather than carry the whole behavior. The safest design is to make the easy tool also be the correct tool.

## Task Waiting And MCP Timeouts

Blocking MCP calls are fragile. This is why the prototype moved away from a synchronous `send_task`/`submit_task` style and toward `delegate_task`: MCP clients and agent harnesses have their own tool-call timeouts, and long-running calls can be killed or marked failed while the worker continues doing real work.

The orchestrator has been observed falling back to shell sleeps such as:

```bash
sleep 44 && echo done
```

That is a sign the MCP API lacks a proper waiting primitive. Shell sleeps waste orchestrator turns, provide no progress, hide stale/stuck tasks, and encourage guessing.

The API should provide bounded multi-task waiting:

```text
wait_tasks(taskIds, sinceEventSeq?, maxWaitSeconds?, returnOnStatuses?)
```

Semantics:

- accepts one or many task IDs
- server caps `maxWaitSeconds` to a conservative client-safe value, likely 30-45 seconds
- returns immediately when any watched task has a new event or reaches an interesting status
- returns snapshots for all watched tasks plus event deltas
- includes `suggestedNextWaitSeconds`
- never blocks until arbitrary task completion

Example response shape:

```json
{
  "eventSeq": 47,
  "changed": [
    {
      "taskId": "b2",
      "status": "completed",
      "phase": "pr_opened",
      "summary": "ykmcorpus opened PR #24; CI pending"
    }
  ],
  "tasks": [
    {
      "taskId": "a1",
      "status": "running",
      "phase": "testing",
      "lastActivitySecondsAgo": 12
    }
  ],
  "suggestedNextWaitSeconds": 30
}
```

This lets the orchestrator run an event loop:

```text
delegate task A
delegate task B
delegate task C
wait_tasks([A, B, C], sinceEventSeq, 30)
handle whichever task changed
repeat until all are terminal or blocked
```

`wait_tasks` should become the preferred waiting path. `get_task` remains an immediate snapshot, and `list_tasks` remains a fleet overview.

There may also be value in a CLI-based waiter, modeled after `gh run watch`:

```bash
codex-fleet watch 389ccdf5 --interval 10
codex-fleet watch 389ccdf5 a1b2c3 --any --interval 10 --timeout 30m
codex-fleet watch --active --any --json
```

This is a tactical escape hatch and human-friendly surface, not a separate state model. It should consume the same daemon task/event state as `wait_tasks`, stream compact progress, exit when one or all watched tasks reach terminal state, and optionally return nonzero on failure. A `--json` mode is important so agent orchestrators can parse final status without scraping terminal text.

This may be useful because agent harnesses appear more willing to run shell waiters such as `gh run watch` or even `sleep 44 && echo done` than long MCP calls. That difference is observed behavior, not a guaranteed contract, so the design should not depend on shell waits being safer. The intended layering is:

```text
daemon task/event state
    -> MCP wait_tasks
    -> CLI codex-fleet watch
    -> TUI/dashboard
```

MCP server instructions should still prefer `wait_tasks` for ordinary orchestration. The CLI waiter is for humans, long terminal-style observation, and fallback when a particular orchestrator handles MCP long-polling poorly.

## POC Worker Semantics

- One worker process per configured repo.
- Work is serialized per worker to avoid racing one Codex conversation.
- Work can run in parallel across workers.
- `newThread: true` starts a fresh native Codex thread.
- `newThread: false` continues the worker's stored thread id when available.
- Thread state must move from memory to daemon-owned persistent state if long-lived repo workers remain part of the design.

## Worker Access Profiles

Worker sandbox and host-access profiles need to match the repo's expected verification workflow. A worker assigned to a repo that uses Docker, local staging, SSH, or deploy scripts will fail or punt work back to the user if it only has `workspace-write` access.

For example, the `agent-broker` worker initially had `workspace-write`, but staging bring-up for `gh-agent-broker` requires Docker access through `vps-ops` (`mise run deploy:staging -- gh-agent-broker`). That worker needs a YOLO-equivalent profile (`danger-full-access` plus `approvalPolicy: never`) or a more structured future permission profile that grants Docker/staging access intentionally.

The final product should make access profiles explicit in worker config and visible to the orchestrator, so it can route Docker/staging/deploy tasks only to workers that can actually perform them.

Near-term default: worker agents should usually run in a YOLO-equivalent mode. The practical value of the fleet comes from workers being able to run repo commands, tests, Docker, SSH, deploy checks, and Git operations without handing every permission decision back to the user or orchestrator. In the future, workers should run in stronger explicit sandboxes or per-repo permission profiles, but today's useful default is broad local access with clear logging and accountability.

Future sandbox option: integrate with `gh-agent-broker`. That project can spin up container sandboxes and supply GitHub credentials. It may provide a middle ground between current local YOLO workers and safer production-grade isolation: workers can be configured to never refuse tool use inside their sandbox, while the sandbox limits blast radius. This will not cover every task, especially host-specific operations like local Docker staging or production SSH, but it may be a strong default for repo-centric coding tasks that need GitHub access.

## Model Tier Routing

Because codex-fleet controls worker launch/configuration, it can expose different Codex model profiles for different task classes. The orchestrator should be able to choose cheaper/faster Codex sessions for simple triage, formatting, mechanical edits, and low-risk diagnostics, while reserving stronger models for ambiguous design work, cross-repo changes, security-sensitive work, or difficult debugging.

This is a cost-control and throughput feature:

- worker or task config should accept an optional model/profile
- `list_clients` should advertise available model tiers or default model policy
- `delegate_task` should allow the orchestrator to request a model tier such as `cheap`, `standard`, or `strong`
- policies should define which task classes are allowed to use cheaper models
- logs should record the requested and actual model/profile for each task
- fallback behavior should be explicit when a requested model/profile is unavailable

The orchestrator should own the routing decision, but the daemon should enforce configured limits so a weak model is not accidentally used for high-risk production, security, merge, or deployment work.

## Security

This service is dangerous by design, especially with YOLO-equivalent workers. A worker with `danger-full-access`, no approval prompts, SSH keys, Docker access, GitHub credentials, and production deployment scripts can cause real damage quickly. Treat this as a privileged automation system, not a chat helper.

The current stdio MCP broker has a useful security property: it is not a listening service. The caller starts it as a child process and talks over inherited stdin/stdout. A persistent daemon improves durability and observability, but it creates a privileged local endpoint. Anyone who can reach that endpoint may be able to trigger broad-access workers unless the daemon has authentication and authorization.

Daemon security baseline:

- bind to a local Unix domain socket by default, not TCP
- put the socket under a `0700` directory
- require a capability token even for local clients
- store client tokens in `0600` files
- identify callers such as Claude/Cowork, CLI, scheduler, and dashboard
- enforce per-client permissions such as list-only, delegate, cleanup, kill, privileged ops
- audit every request with caller identity
- make TCP listeners opt-in only
- never run the daemon as root unless there is a very specific external sandbox story

Security concerns to address before production use:

- least-privilege worker profiles rather than one broad YOLO profile
- explicit distinction between repo-scoped workers and production/ops capability workers
- audit logs that are tamper-resistant enough to reconstruct who asked for what
- clear human gates for merge, deploy, production SSH, secret access, and destructive commands
- per-task risk classification shown to the orchestrator and user
- secrets redaction in logs and dashboards
- allow/deny policy for commands, paths, network targets, and credentials
- kill switch for the whole fleet and per-worker cancellation
- credential scoping and rotation for GitHub and SSH
- isolation for untrusted repo code, ideally via containers or worktrees with constrained credentials
- dashboard visibility so privileged work is not invisible

Near-term YOLO mode is useful for proving value, but the final product needs a deliberate security model.

## Logging Requirements

Keep JSONL logs, but make them first-class:

- task id
- worker name
- prompt preview
- response preview
- status
- timestamps
- duration
- Codex thread id
- error
- tool/client version
- broker/daemon instance id

Full prompts and responses should remain opt-in because SSH diagnostics and deployment output may contain sensitive data.

## Observability And Dashboard

The user experience gets weak quickly when workers are active but invisible. Logs are useful after the fact, but during live orchestration the user needs a dashboard-like view of the fleet.

This is not optional polish. The POC repeatedly forced the human to guess what was happening by combining Cowork narration, GitHub side effects, local git state, JSONL logs, and process lists. Sometimes work was actually progressing, sometimes a worker gave up, and sometimes the orchestrator or Cowork app became stale or confused. The product needs a UI/control plane that makes task truth visible.

A useful dashboard should show:

- active workers and their repo cwd
- current task id per worker
- task status and elapsed time
- prompt preview
- recent response/status preview
- current branch and git cleanliness
- last command or high-level activity when available
- PR URL / CI state when a worker is in delivery mode
- retry/failure state
- which orchestrator session created the task
- reconciliation state: reported by worker, inferred from PR merge, stale-running, cleanup pending
- worker process state and last heartbeat
- task worktree path, branch, base commit, current commit, and dirty state
- model/profile, sandbox, approval policy, and risk classification

This should start as a codex-fleet-native task control plane, not merely a terminal multiplexer. A multiplexer can show process output, but it does not know the authoritative task model: task id, orchestrator prompt, repo/capability target, worktree, branch, PR, CI, cleanup ownership, and whether completion was inferred from durable evidence rather than reported by the worker.

First useful version:

- read-only CLI/TUI status from daemon state, JSONL logs, local git/worktree state, process state, and GitHub PR/CI reconciliation
- fleet summary: active, idle, stale, blocked, cleanup candidates
- one box per active task/profile with idle/busy indicators and scrolling event activity
- selected task detail showing prompt preview, event timeline, branch/worktree, PR/CI, and reconciliation status
- no destructive actions at first

Example fleet row:

```text
agent-broker  STALE?  task 389ccdf5  PR #51 merged  no task_finished
youknowme     IDLE    last task done  PR #82 merged
vps-ops       IDLE    last task done  prod deploy completed
ykmcorpus     IDLE    clean main
```

Example task detail:

```text
Task: 389ccdf5
Profile: agent-broker
Started: 05:27:58Z
Last broker event: task_started
Branch: feature/broker-finalization-and-status-mapping
PR: #51 merged at 05:44:18Z
CI: all required checks passed
Worktree: removed
Reconciled status: completed-by-pr-merge
Broker status: stale-running
```

Useful visual states:

- queued
- booting
- planning
- executing
- testing
- committing
- opening-pr
- waiting-ci
- blocked
- needs-human
- completed
- failed
- stale-running
- cleanup-pending
- cleaned

Ghostty or another capable terminal can support a rich TUI. Candidate implementation stacks include TypeScript (`neo-blessed`, `ink`), Go (`bubbletea`/`lipgloss`), or Rust (`ratatui`). Since the repo is currently TypeScript, a read-only Node TUI may be the fastest first step, but the most important part is trustworthy daemon state and reconciliation, not the UI library.

## Existing Agent Multiplexer Candidates

`cmux` already covers much of the desired live-visibility surface: a native macOS terminal for coding agents, vertical tabs, split panes, notification rings, per-workspace context, an embedded browser, and a scriptable CLI/socket API. It works with terminal-native agents such as Codex CLI and Claude Code rather than requiring a specific agent runtime.

`herdr` appears to cover a similar space from a terminal-native direction: workspaces, tabs, panes, detach/reattach, real terminal views, agent state at a glance, and a socket API. Its published comparison also claims agent orchestration support, which makes it especially relevant to evaluate before building our own visual control plane.

These tools may help with terminal process visibility, but they probably cannot replace the codex-fleet UI/control plane. They do not inherently know codex-fleet task identity, worktree ownership, PR/CI reconciliation, cleanup state, or whether an agent completed through durable side effects without reporting back.

Use them only if they cleanly integrate with codex-fleet's daemon state. The default plan should be a codex-fleet-native read-only status/control UI first, with cmux/herdr considered later as optional terminal-pane surfaces.

Possible integration directions:

- launch one multiplexer workspace/tab/pane per active worker or task
- title panes with worker name, repo, task id, branch, and status
- use multiplexer notifications when workers need attention or tasks finish
- expose a `codex-fleet open-dashboard` or `codex-fleet attach` command that arranges panes from daemon state
- use the multiplexer for visual inspection while the daemon remains the durable source of truth

Evaluation criteria:

- can it launch and label Codex worker panes programmatically?
- can it attach/detach without killing active worker commands?
- can external code query pane/session/agent state reliably?
- can external code send input to the right pane without focus bugs?
- can it surface task metadata from codex-fleet rather than only terminal heuristics?
- can it run headlessly or over SSH where useful?
- is the license and distribution model compatible with the desired product?

This does not replace the daemon requirement. Claude/Cowork still needs a stable MCP endpoint, durable task state, and machine-readable status independent of whether a human has cmux open.

## Open Questions

- How long can multiple local Codex ChatGPT-authenticated sessions run before subscription limits or throttling become noticeable?
- Should workers have explicit max concurrency of one forever, or allow multiple independent threads per repo?
- Should `reset_client_thread` be per worker, per task, or replaced by explicit named conversation handles?
- What cancellation mechanism should be exposed to the orchestrator?
- Should the daemon expose an HTTP API, Unix socket, or both?
- Should codex-fleet depend on cmux/herdr, optionally integrate with one or both, or keep a separate dashboard abstraction that can target external multiplexers first and other frontends later?

## Immediate Next Steps

- Remove public `send_task`, `start_task`, and possibly `broadcast_task`.
- Add a persistent daemon and make MCP stdio a proxy.
- Persist task state and thread ids.
- Add a small CLI for `list`, `delegate`, `status`, `logs`, and `workers`.
- Prototype cmux or herdr integration for launching/attaching visible worker panes from daemon state.
- Add a test harness that validates MCP output schemas against Claude-strict behavior.
