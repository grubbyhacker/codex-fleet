# DCR-0009: Tool Telemetry And Dashboard Polling

Status: Accepted
Date: 2026-07-01

## Context

Fleet task events showed enough activity to know when workers were alive, but not enough detail to diagnose inefficient worker behavior. Long runs could show generic `codex/event` entries such as `exec_command_output_delta` without the command class, redacted command preview, or duration. That made it hard to distinguish useful work from passive waits such as GitHub watch loops, sleeping probes, or unbounded SSH/curl commands.

The TUI also polled the daemon every second and, for a selected task, made three read RPCs per refresh: `list_tasks`, `get_task`, and `get_task_history`. In long operator sessions this created tens of thousands of audit log records without improving worker execution.

## Decision

Fleet will enrich `task_activity` events with optional sanitized tool telemetry when Codex notifications provide enough structure:

- event type;
- tool name when available;
- call id when available;
- redacted command preview when available;
- duration and exit code on matching tool end events.

Full stdout/stderr and complete command payloads remain out of the event log by default. The telemetry is intended for operational diagnosis and recommendation generation, not semantic completion.

The TUI will refresh every five seconds by default, configurable with `CODEX_FLEET_TUI_REFRESH_MS`, and will reuse selected-task detail/history while the compact task row is unchanged.

## Consequences

- Future postmortems can identify likely waste patterns such as `gh --watch`, shell sleep loops, or long network probes without retaining full output.
- Audit-log growth from an open dashboard is reduced substantially.
- Installed binaries must be rebuilt and the LaunchAgent/TUI restarted before this behavior is live.
