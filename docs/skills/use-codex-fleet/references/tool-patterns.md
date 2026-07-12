# Codex Fleet Tool Patterns

## MCP Tools

Use the official `mcp__codex_fleet` server.

Available MCP methods:

- `initialize({ "sessionName": "short-name" })`
- `list_targets({})`
- `delegate_task({ target, deliveryMode, risk, modelTier, modelRoute, prompt })`
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

## When Not To Delegate

Do not use Fleet reflexively for every repo mutation. Direct local work is usually
better for a single narrow task in the current checkout when the orchestrator can
make the edit, validate it, and hand it off without needing Fleet-owned isolation,
durable background execution, parallel workers, shell scratch isolation, or PR
postcondition enforcement.

Use Fleet for a single task only when one of those concrete Fleet capabilities is
part of the value. Use Fleet by default for independent parallel tasks, cross-repo
coordination, long-running work that should survive the orchestrator's active
turn, or work where a clean worker-owned branch/worktree/PR handoff materially
reduces risk.

## Typical Repo Research Delegation

```json
{
  "target": { "repo": "thoughts" },
  "deliveryMode": "research_only",
  "risk": "low",
  "modelTier": "cheap",
  "prompt": "Treat CLAUDE.md the same as AGENTS.md. Read repo guidance first. Work in Fleet-owned task resources only. Inspect the requested area and report concise findings with exact paths and commands."
}
```

## Typical Repo PR Delegation

Use this pattern when Fleet-owned isolation or PR handoff is useful. It is not a
requirement for every repository edit.

```json
{
  "target": { "repo": "thoughts" },
  "deliveryMode": "pr_for_review",
  "risk": "low",
  "modelTier": "standard",
  "prompt": "Treat CLAUDE.md the same as AGENTS.md. Read repo guidance first. Work in Fleet-owned task resources only. Respect the target repo merge policy from list_targets. Implement the requested change, run the documented validation, open a PR for review, and report the branch, commit, PR URL, validation results, and any residual risks."
}
```

## Explicit GPT-5.6 Route Delegation

Omit `modelRoute` for Fleet's default route, currently `gpt-5.6-terra`. Set
`modelRoute` only when the task justifies a different concrete model.

```json
{
  "target": { "repo": "thoughts" },
  "deliveryMode": "research_only",
  "risk": "high",
  "modelTier": "strong",
  "modelRoute": "gpt-5.6-sol",
  "prompt": "Use GPT-5.6 Sol for this security-sensitive architecture review. Read repo guidance first and report concise findings with exact paths."
}
```

Use `gpt-5.5` for conservative fallback, `gpt-5.6-luna` for narrow fast 5.6
work, and `gpt-5.6-sol` only for the hardest long-horizon, ambiguous,
security-sensitive, or high-consequence tasks. Omit `modelRoute` for normal
Terra work.

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

Do not use shell sleeps or broad list polling as a substitute for `wait_tasks`.
Anti-patterns:

- `sleep 30`, then `list_tasks`
- repeated `list_tasks` calls for one known task id
- user-visible narration such as `Checking the task state now` before each poll

Use `list_tasks` for initial context, cleanup safety checks, broad queue views,
or recovering task ids. Once you have a task id, use `wait_tasks` to monitor it.

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
7. If the terminal state is surprising, such as `timed_out` after recent activity, call `get_task_history` before deciding whether to resume, inspect the worktree, or report a blocker.
8. If still running, continue waiting. Do not send a user-visible message just because the wait loop continues.

`wait_tasks` returns immediately when new events exist or when a snapshot already matches `returnOnStatuses`. Otherwise it sleeps up to `maxWaitSeconds` capped at 45 seconds.

When a running worker emits no detail during a wait slice, `wait_tasks` can return a `task_observation` event with the current state, `lastActivityAt`, and quiet duration. Use those facts to keep your own confidence in the task state, not as a reason to post another status line. Do not call `get_task` repeatedly or shorten waits only because a worker has not emitted detailed progress. Fleet will mark quiet workers `stale` when the daemon's stale threshold is reached.

Do not narrate wait loops. In particular, do not post messages like:

- `Checking the Hermes role fix state now.`
- `It read the repo instructions, inventory, and group vars.`
- `It read the service roles and host-maintenance roles.`
- `It inspected the diff and applied a follow-up patch.`
- `Still cooking.`
- `The worker is quiet for about 35 seconds but still heartbeating; I will keep waiting.`
- `I am waiting for the PR URL.` after each `wait_tasks` call.

Only update the user for material milestones: task delegated, terminal/stale/failed state, a concrete blocker, or a decision the orchestrator must make. If the message only proves that the wait loop is continuing, omit it.

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

Use `end_task` to release Fleet-owned resources for a terminal task when you are done inspecting those resources. This is not post-merge repository hygiene, and it does not require updating the target repo's normal checkout.

```json
{
  "taskId": "<full-task-id>",
  "reason": "Task is complete and the orchestrator no longer needs the Fleet-owned resources."
}
```

For normal PR handoff:

1. Inspect the terminal task and capture the PR URL, branch, commit, validation, and one external check snapshot.
2. Report those facts to the operator.
3. Call `end_task` if you no longer need the Fleet-owned worktree for review follow-up.
4. Stop. Do not wait for merge just to perform cleanup later.

If the operator later says the PR was merged, treat that as informational unless they ask for another action. Do not run `git fetch`, fast-forward the default branch, delete local branches, push branch deletions, or delegate a cleanup worker merely because the PR merged. GitHub remote branch auto-deletion and Fleet maintenance/TTL cleanup handle routine hygiene.

For shell tasks, `end_task` removes the shell scratch directory.

For repo tasks, `end_task` removes clean Fleet-owned worktrees and prunes eligible Fleet-owned branches. It blocks if the worktree is dirty. When blocked:

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

## Not For Fleet Administration

This skill is for orchestrators using Fleet to delegate and monitor worker
tasks. It is not the operating manual for Codex Fleet itself. If the user asks
you to develop, debug, deploy, or administer Fleet, work directly in the
`codex-fleet` repo and its operational docs rather than applying these
orchestrator patterns.

Ordinary orchestrators should not manage Fleet processes. If the MCP transport
is closed, continue with safe non-Fleet work when possible and ask the operator
to reconnect the MCP client when Fleet delegation is needed.
