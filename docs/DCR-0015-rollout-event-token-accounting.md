# DCR-0015: Rollout-Event Token Accounting

Status: Accepted
Date: 2026-07-13

## Context

DCR-0003 allowed the TUI to show daily, weekly, and monthly Codex token totals from the local Codex state database. The initial query summed each thread's lifetime `tokens_used` value when that thread was updated inside a reporting window. A long-lived thread touched today therefore contributed its entire historical usage to “today,” overstating time-bounded totals and hiding the large difference between cached input, new input, and output.

Codex rollout JSONL files contain timestamped `token_count` events with per-call `last_token_usage` values. They also record the active model in `turn_context` events, including model changes inside one conversation.

## Decision

The TUI derives local daily, weekly, and monthly raw-token totals from timestamped rollout `last_token_usage` events rather than lifetime thread totals. It streams only rollouts belonging to threads updated within the earliest displayed window and caches the resulting summary for one minute.

The persistent dashboard usage area shows:

- raw tokens and model-call count for today, plus weekly and monthly raw totals;
- today's input, cached-input ratio, uncached input, output, reasoning output (a subset of output), and any unclassified total-only usage;
- today's raw-token totals by the model active for each turn.

This remains best-effort, read-only local accounting. “Raw tokens” is deliberately not labeled as monetary cost or billable usage.

## Consequences

- Time-window totals represent activity within the window instead of the lifetime usage of recently active threads.
- Operators can distinguish repeated cached context from newly processed input and generated output.
- Model switches within a conversation are attributed per turn.
- The TUI performs bounded streaming reads of local rollout files once per cache interval; missing, rotating, malformed, or partially written rollouts do not prevent dashboard startup.
