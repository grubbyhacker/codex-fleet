# DCR-0014: Coalesced Task Waits

Date: 2026-07-13

## Context

The original design made `wait_tasks` return on any new task event. That kept
progress visible when events were sparse. In current workers, heartbeats and
tool telemetry can arrive continuously. An orchestrator waiting for terminal or
stale states can therefore receive a rapid series of immediate responses while
all tasks remain `running`, encouraging polling or shell sleeps instead of a
bounded Fleet wait.

The implementation also used a fixed sleep after checking for existing events.
It could not interrupt that sleep when a requested state arrived, repeated full
retained prompts and outputs in each snapshot, and required callers to derive
their next cursor from the final returned event.

## Decision

Extend `wait_tasks` with explicit wake and snapshot controls:

- `wakeOn: "any_event" | "material_event" | "requested_status"`
- `snapshotDetail: "compact" | "full"`

`any_event` remains the default wake mode for compatibility with the original
design. `material_event` ignores `task_activity` and `task_observation` events,
including heartbeats and command/patch telemetry, while still returning all
coalesced event deltas when a lifecycle or attention event wakes the call.
`requested_status` requires `returnOnStatuses`, accumulates event deltas without
waking for them, and returns only when a requested state is observed or the
bounded timeout expires.

Replace the fixed sleep with an interruptible in-process event notification.
All modes wake internally to re-evaluate task state, but only the selected wake
condition or timeout completes the RPC call. This lets terminal and stale
transitions interrupt a `requested_status` wait immediately.

Compact snapshots are the default for `wait_tasks`. They omit full retained
prompts, final responses, and worker stderr while preserving their previews.
Callers can request `full` snapshots explicitly. Every response includes
`nextEventSeq` and `wakeReason` in addition to snapshots, coalesced events, and
the suggested next wait duration.

## Consequences

Orchestrators can block for 30–45 second slices without rapid heartbeat-driven
returns, while still reacting immediately to terminal or stale task states.
Callers no longer need to inspect the final event to maintain a cursor, and
routine wait responses remain small even when tasks retain large prompts or
outputs.

Existing callers that omit `wakeOn` continue to receive any-event behavior.
The preferred orchestration pattern is `wakeOn: "requested_status"`, terminal
and stale `returnOnStatuses`, `snapshotDetail: "compact"`, and carrying
`nextEventSeq` into the next call.
