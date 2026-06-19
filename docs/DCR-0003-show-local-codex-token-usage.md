# DCR-0003: Show Local Codex Token Usage In The TUI

Status: Accepted
Date: 2026-06-19

## Context

`docs/DESIGN.md` says dashboard usage measures should be simple aggregate counters over Fleet's durable task store and event log. Operator feedback asked for daily, weekly, and monthly Codex token consumption to be visible at all times in the TUI.

Fleet task state does not currently record token usage per worker turn. Codex's local state database already contains thread-level token usage for the operator's local Codex account.

## Decision

For local single-operator v1, the TUI may read Codex's local state database and show daily, weekly, and monthly token totals in the dashboard header.

This is a read-only operator convenience, not daemon-owned Fleet accounting. If the Codex state database is unavailable or its schema cannot be read, the TUI shows `n/a` rather than failing startup.

## Consequences

- Operators get immediate cost/usage awareness without waiting for Fleet-native token accounting.
- The dashboard remains read-only and continues to use daemon RPC for Fleet task state.
- The token line is best-effort and local-machine specific.
- Future daemon-owned usage accounting should replace or augment this once worker events include reliable token metrics.
