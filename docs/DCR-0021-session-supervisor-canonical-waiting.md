# DCR-0021: Canonical session-supervisor waiting

Status: accepted · Date: 2026-07-20

The immutable `session-supervisor/journal/v2` contract now has a canonical
nonterminal `waiting` verifier outcome in package 2.2.0. It records a typed,
digest-bound verifier observation and fixed poll deadline against one active
task, model turn, verifier effect, and session fence. It deliberately has no
model, continuation, budget, satisfaction, or cleanup authority.

This is a narrow correction to the product behavior described in `DESIGN.md`:
the package stays backend-neutral, while the consuming runtime owns broker
transport, observation parsing, polling, and deadline scheduling. Version 2.2.0
replays valid 2.1 journals unchanged. Journals containing `completion_waiting`
fail closed in 2.1 because no reverse adapter is safe.
