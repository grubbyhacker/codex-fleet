# DCR-0002: Retain Full Task Prompts For Operator Inspection

Status: Accepted
Date: 2026-06-18

## Context

`docs/DESIGN.md` treats full prompt retention as opt-in because prompts may contain sensitive operational details. During productionization, operator feedback made prompt visibility a core debugging need: when a worker behaves unexpectedly, the operator needs to inspect exactly what Fleet sent to that worker without reconstructing it from truncated event previews.

The current implementation stores only `promptPreview`, so the TUI and `get_task` cannot show the full worker prompt.

## Decision

For the local single-operator v1, retain the full delegated prompt in daemon task state and task events. `get_task` may return the full prompt for a visible task. `list_tasks` must remain compact and must not include full prompt bodies.

Resume prompts are retained as new task-history events and update the task's latest prompt fields. This keeps the current task snapshot useful while preserving the per-turn record in history.

## Consequences

- The TUI can show the prompt for the selected task.
- Operators can diagnose worker behavior without relying on truncated previews.
- Prompt contents now have the same local sensitivity as retained final responses and worker stderr.
- Future multi-user or remote deployments should revisit this and move full prompt bodies behind an explicit retention setting or payload refs.
