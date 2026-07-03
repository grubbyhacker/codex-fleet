---
name: use-codex-fleet
description: "Use Codex Fleet to delegate work to local Codex worker agents through the official codex-fleet MCP server. Use when you need Fleet to hand a task to repo or shell workers, monitor delegated worker tasks without excessive polling, choose delivery modes/model tiers, or release Fleet-owned resources after delegated work. Do not use for developing, debugging, deploying, or administering Codex Fleet itself; for that, work directly in the codex-fleet repo and its operational docs."
---

# Use Codex Fleet

Codex Fleet is a local orchestration utility. Treat it as a task runner and state tracker for Codex workers, not as another reasoning authority.

Use the official `codex-fleet` MCP tools.

## Core Rules

1. Start by checking context:
   - Use `list_targets` when you are not sure which repo or shell targets exist.
   - Use `initialize` with a short `sessionName` when starting a coordinated session and the tool is available.
   - Use `list_tasks` before restarting services, cleaning action queues, or assuming no workers are active.

2. Delegate asynchronously:
   - Use `delegate_task` for meaningful work.
   - Treat the returned `taskId` as the durable handle.
   - Keep the full task id. Short ids can become ambiguous or fail after daemon reloads.

3. Wait without churn:
   - Use `wait_tasks` as the primary monitoring primitive.
   - Do not run shell sleeps such as `sleep 30` to wait for Fleet work. `wait_tasks` is the wait primitive.
   - Do not poll a known task with repeated `list_tasks`; use `wait_tasks` for active monitoring and `get_task` after terminal/stale/unexpected states. `list_tasks` is for broad context checks, not per-task wait loops.
   - For normal active workers, use `maxWaitSeconds` 30-45 and include terminal/stale `returnOnStatuses`.
   - Carry forward the highest event `seq` you have seen as `sinceEventSeq`.
   - Quiet workers can happen. Do not call `get_task` just because a worker has not emitted detailed progress, but do surface the concrete `wait_tasks` facts: returned events, current state, `lastActivityAt`, and quiet duration when present.
   - Use `get_task` after terminal, stale, failed, or unexpected states, or when you need full prompt/output/stderr/worktree details.
   - Do not narrate every wait loop. Do not post user-visible status merely because `wait_tasks` returned and you are about to wait again.
   - Only update the user for material milestones: task delegated, terminal/stale/failed state, a concrete blocker, or a decision the orchestrator must make.
   - Do not say things like "Checking state now", "It read the repo instructions", "It read the service roles", "It inspected the diff", "Still cooking", "The worker is quiet but still running", or "I am waiting for the PR URL" after each wait.

4. Keep ownership of pending work:
   - If Fleet tasks are still running and you have no other immediate work, keep waiting with `wait_tasks`.
   - Do not return control to the user merely because workers are quiet.
   - Do not describe a lack of detailed progress as "normal for Fleet" without also reporting observed task ids, states, and last activity/quiet timing.
   - Returning control is appropriate when all tasks are terminal, blocked, stale and needing a user choice, explicitly paused by the user, or impossible to continue without external input.
   - If you must return control with pending tasks, report the exact task ids, current states, and the next `wait_tasks` call to make.

5. Inspect before acting:
   - Use `get_task_history` when the state changed unexpectedly or the final result is not enough.
   - Remember that Fleet reports operational state. The orchestrator still decides whether the worker semantically completed the user's goal.

6. Handle external waits deliberately:
   - Do not resume or delegate a repo worker only to poll GitHub Actions, CI, deploy status, or other external systems.
   - For normal PR handoff, accept a worker's PR URL plus one concrete check snapshot; if checks are still pending, report that pending state and stop unless the user asked you to carry through completion.
   - If the user asked for completion after external checks, the orchestrator should wait directly on the external system with a purpose-built tool or CLI, update the user only on material status changes or final outcome, then resume the worker only if code changes, merge, cleanup, or failure triage is needed.
   - If a worker is already waiting on an external system as part of explicit delivery authority, let it work quietly through `wait_tasks`; do not narrate every poll or observation.
   - Be explicit in prompts: "ready PR and stop" is different from "merge/deploy after green checks." Do not rely on vague phrases like "run until the PR is complete."

7. Release Fleet-owned resources without becoming the janitor:
   - Treat `end_task` as release of Fleet-owned task resources, not as post-merge repository hygiene.
   - For normal PR handoff, inspect the terminal task, report the ready PR and one check snapshot, then call `end_task` only if you no longer need the task worktree for follow-up.
   - Do not wait for the human to merge a PR just so you can clean up afterward. If the operator later says a PR was merged, do not run `git fetch`, fast-forward a checkout, delete local branches, push branch deletions, or launch a cleanup worker unless they explicitly ask.
   - If `end_task` reports cleanup conflict because a worktree is dirty, inspect `get_task` before removing anything.
   - Use CLI/TUI `wipe-clean` only as an operator cleanup action for terminal Fleet-owned resources. It intentionally discards dirty/ahead worktrees and skips live tasks.

8. Do not interrupt live workers casually:
   - Ordinary orchestrators should not administer Fleet infrastructure. Do not restart the daemon, unload the LaunchAgent, kill adapter processes, or run broad cleanup as part of normal delegated work.
   - If the Fleet MCP transport is closed, do not treat that as a repo-work blocker. Continue with direct repo reads or other non-Fleet tools when that is safe, and tell the operator that the MCP client needs to reconnect if Fleet delegation is required.
   - If the user asks you to develop, debug, deploy, or administer Codex Fleet itself, this skill is the wrong tool. Work directly in the `codex-fleet` repo and its operational docs instead of following orchestrator delegation guidance.

## Delegation Choices

Choose the smallest delivery mode that matches the requested outcome:

- `research_only`: inspect, answer, diagnose, or produce a plan. Prefer this for fact-finding and repo questions.
- `patch`: make local changes without promising a PR.
- `pr_for_review`: create a branch/PR for human review. This is the normal choice for repo changes.
- `full_delivery`: carry implementation through validation and requested delivery steps, but respect the repo's merge policy. In `human_review` repos, full delivery stops after a ready PR and one CI/check snapshot.
- `push_to_main`: use only when the user explicitly wants direct main-branch delivery.

Choose the target deliberately:

- `target: { "repo": "<alias>" }` for repo-scoped work. Fleet creates or uses task-owned repo resources.
- `target: { "shell": true }` for host-shell work that is not tied to a repo. Shell workers start in Fleet-owned scratch space and should not mutate shared checkouts unless explicitly instructed.

Choose model tier by risk and complexity:

- `cheap`: default choice for smoke tests, codebase exploration, read-heavy scans, simple read-only checks, and tiny mechanical work. Fleet routes this tier to a smaller worker model when allowed.
- `standard`: normal repo tasks and implementation slices that need more judgment than a scan but are not high-risk.
- `strong`: high-risk changes, ambiguous architecture, security-sensitive work, or work likely to require deep judgment.

Fleet may upgrade the actual model tier for safety or availability. Check `requestedModel`, `actualModel`, `workerModel`, and `workerReasoningEffort` in task snapshots when model choice matters.

## Worker Prompts

Give workers all operational boundaries up front:

- repo or shell target and the requested delivery mode;
- whether to treat `CLAUDE.md` the same as `AGENTS.md`;
- branch, PR, validation, or merge expectations;
- the repo merge policy shown by `list_targets` when merge behavior matters;
- what not to touch;
- whether production, live services, or shared checkouts are off limits;
- when to stop and report rather than improvise.

For repo tasks, tell workers to respect repo guidance files, keep unrelated working-tree changes alone, validate with the repo's documented commands, and report exact paths, branches, commits, PRs, and failing checks.

For PR-producing repo tasks, tell workers not to wait indefinitely on external checks. The expected handoff is a ready PR plus one check snapshot with pending/running/failing/passing status and URLs or run ids when available. Only ask a worker to wait for checks when the prompt explicitly requires a merge or another post-check delivery step.

When the goal is human review, tell the worker to release its turn after opening/updating the ready PR. Merging and deploy verification are separate explicit goals. Post-merge branch/worktree cleanup is maintenance work, not a normal orchestrator follow-up after the operator says the PR merged.

## Reference

Read [references/tool-patterns.md](references/tool-patterns.md) when you need exact MCP call patterns, CLI/TUI cleanup commands, or a wait-loop template.
