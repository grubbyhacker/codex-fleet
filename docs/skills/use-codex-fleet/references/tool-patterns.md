# Codex Fleet Tool Patterns

## MCP Tools

Use the official `mcp__codex_fleet` server. Avoid `mcp__codex_fleet_poc` unless the user explicitly asks for the old prototype.

Available MCP methods:

- `initialize({ "sessionName": "short-name" })`
- `list_targets({})`
- `delegate_task({ target, deliveryMode, risk, modelTier, prompt })`
- `get_task({ "taskId": "<full-id>" })`
- `wait_tasks({ taskIds, sinceEventSeq, maxWaitSeconds, returnOnStatuses })`
- `list_tasks({ states, targetId, updatedSince, limit })`
- `get_task_history({ taskId, limit })`
- `end_task({ taskId, reason })`

Task states:

- `queued`
- `running`
- `exited`
- `failed_to_start`
- `cancelled`
- `timed_out`
- `stale`

Delivery modes:

- `research_only`
- `patch`
- `pr_for_review`
- `full_delivery`
- `push_to_main`

Model tiers:

- `cheap`
- `standard`
- `strong`

Risk values:

- `low`
- `standard`
- `high`

Repo merge policies:

- `human_review`: open/update a ready PR and stop before merge.
- `agent_merge_explicit`: merge only when the task prompt explicitly instructs that PR to be merged.
- `agent_merge_allowed`: merge when delivery mode, prompt, repo rules, and checks allow it.

## Typical Repo Delegation

```json
{
  "target": { "repo": "thoughts" },
  "deliveryMode": "pr_for_review",
  "risk": "low",
  "modelTier": "standard",
  "prompt": "Treat CLAUDE.md the same as AGENTS.md. Read repo guidance first. Work in Fleet-owned task resources only. Respect the target repo merge policy from list_targets. Implement the requested change, run the documented validation, open a PR for review, and report the branch, commit, PR URL, validation results, and any residual risks."
}
```

## Typical Shell Delegation

```json
{
  "target": { "shell": true },
  "deliveryMode": "research_only",
  "risk": "low",
  "modelTier": "cheap",
  "prompt": "Use the Fleet-owned shell scratch directory. Do not mutate shared checkouts or production resources. Inspect the requested thing and report findings with exact commands and evidence."
}
```

## Bounded Wait Loop

After `delegate_task` returns a `taskId`, wait in bounded loops with `wait_tasks`. Do not use the user as the wait primitive.

Pseudo-flow:

1. Set `sinceEventSeq` to unset for the first call.
2. Call:

```json
{
  "taskIds": ["<full-task-id>"],
  "maxWaitSeconds": 45,
  "returnOnStatuses": ["exited", "failed_to_start", "cancelled", "timed_out", "stale"]
}
```

3. Read returned `events` and `snapshots`.
4. Note `suggestedNextWaitSeconds`; use it as a pacing hint, but prefer 30-45s waits for ordinary running workers.
5. Save the maximum returned `event.seq`; pass it as `sinceEventSeq` on the next wait.
6. If a snapshot is terminal or stale, call `get_task`.
7. If still running, continue waiting. Briefly update the user only when there are useful new events, first/occasional task observations, terminal/stale transitions, or meaningful elapsed time.

`wait_tasks` returns immediately when new events exist or when a snapshot already matches `returnOnStatuses`. Otherwise it sleeps up to `maxWaitSeconds` capped at 45 seconds.

When a running worker emits no detail during a wait slice, `wait_tasks` can return a `task_observation` event with the current state, `lastActivityAt`, and quiet duration. Use those facts to keep your own confidence in the task state, and surface them sparingly rather than narrating every quiet wait. Do not call `get_task` repeatedly or shorten waits only because a worker has not emitted detailed progress. Fleet will mark quiet workers `stale` when the daemon's stale threshold is reached.

## External Checks And CI

Avoid nested passive waiting. A repo worker should not spend a long turn polling GitHub Actions or CI while the orchestrator polls the worker and narrates each poll.

For PR-producing repo tasks, the normal worker handoff is:

1. implement and validate locally;
2. commit, push, and open/update the PR;
3. take one external check snapshot, such as current GitHub checks or workflow run ids;
4. exit with the PR URL, check snapshot, local validation, and any pending/failing checks.

If checks are pending at handoff, do not resume the repo worker just to poll. Either report the pending PR/check state and stop, or, when the user asked for completion after checks, wait directly on the external system with a purpose-built tool or CLI. User-facing updates should happen on material status changes or final outcome, not every polling interval.

Only ask a worker to wait on external checks when the worker needs the result to perform an explicitly requested delivery step, such as merging after green checks in a repo whose merge policy allows it. In that case, let the worker wait quietly and keep using `wait_tasks` without narrating repeated observations.

Use precise handoff language in worker prompts. "Open a ready PR and stop" means the worker should release its turn after the PR URL and one check snapshot. "Merge/deploy after green checks" is a separate instruction and should be used only when the user actually wants that full delivery.

## Completion Semantics

Fleet knows hard operational facts:

- a worker started;
- a worker exited, failed to start, timed out, was cancelled, or went stale;
- the worker's final response and stderr;
- branch, worktree, shell path, model tier, task events, and post-run worktree status.

Fleet does not know whether the user's goal is semantically done. The orchestrator must read the final response, inspect artifacts or PRs when needed, decide whether follow-up is required, and only then release the task.

## Cleanup

Use `end_task` when you are done with a terminal task:

```json
{
  "taskId": "<full-task-id>",
  "reason": "Task is complete and the orchestrator no longer needs the Fleet-owned resources."
}
```

For shell tasks, `end_task` removes the shell scratch directory.

For repo tasks, `end_task` removes clean Fleet-owned worktrees and prunes merged Fleet branches. It blocks if the worktree is dirty. When blocked:

1. Call `get_task`.
2. Inspect the worktree path and final response.
3. Preserve useful work through commit/PR or another explicit handoff.
4. Only discard with operator-level cleanup when it is truly disposable.

Operator cleanup commands:

```sh
codex-fleet cleanup list --dry-run
codex-fleet cleanup run --task <taskId>
codex-fleet cleanup run --task <taskId> --force
codex-fleet cleanup wipe-clean --dry-run
codex-fleet cleanup wipe-clean
```

`wipe-clean` removes terminal Fleet-owned repo worktrees, including dirty or ahead-of-base worktrees, and force-deletes Fleet branches when present. It skips live tasks. Use it only when the user wants the local action queue cleaned.

## Fleet Admin Service Safety

This section is for explicit Codex Fleet administration tasks. Ordinary
orchestrators should not manage Fleet processes; if the MCP transport is closed,
continue with safe non-Fleet work when possible and ask the operator to reconnect
the MCP client when Fleet delegation is needed.

Before restarting or changing Fleet services:

1. Call `list_tasks({ "states": ["queued", "running", "stale"], "limit": 50 })`.
2. If any task is active, report the task ids and ask before interrupting.
3. For local binary deploys from the `codex-fleet` repo, run `mise exec -- bun run deploy:local`.
4. Restart the daemon or LaunchAgent directly only after the live queue is empty or the user approves interruption.

Standing processes such as `codex-fleet-daemon`, `codex-fleet-mcp`, and `codex-fleet-tui` are normal local infrastructure. Do not kill them as task cleanup.

`codex-fleet-mcp` is different from the daemon: it is a stdio adapter launched
and owned by the MCP client. Killing adapter processes closes active
orchestrator transports. `deploy:local` intentionally leaves existing
`codex-fleet-mcp` processes alone. Existing clients will keep their current
adapter until they reconnect; if the updated adapter must be loaded immediately,
ask the operator to restart or reconnect the MCP client.
