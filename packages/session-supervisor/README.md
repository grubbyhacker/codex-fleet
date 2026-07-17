# `@codex-fleet/session-supervisor`

This package is the compiled backend-neutral core for durable logical sessions.
It supplies strict protocol schemas and pure reducers for append-before-invoke
session state, registered completion contracts, deterministic continuation
inputs, cumulative usage budgets, and exact coordinator adoption.

It deliberately does not contain Fleet targets, worktree cleanup, desktop
management, credentials, provider selection, host shell authority, transport,
storage, runtime adapters, verifier implementations, or janitorial execution.
Those remain responsibilities of the consuming system.

## Registered completion

`RegisteredTaskRegistry` compiles each task kind to one strict parameter schema,
completion contract, verifier identity, reason-code set, contract digest, and
budget. Callers may select a registered task kind and provide validated
parameters; they cannot select a verifier or inject commands. Verifier results
carry only typed outcomes, bounded reason codes, opaque evidence references,
and exact contract/evidence revisions.

`ContinuationBudgetAccount` returns journal-ready reservation, usage, and
exhaustion events. A consumer must durably append a reservation before invoking
a model turn and durably append exact usage afterward. Deterministic
continuation prompts contain sorted reason codes, never verifier prose.

## Reassignment

`SessionReassignmentReducer` validates agentd's atomic adoption step. It
requires an exact predecessor binding and a one-step fence increase, returns an
immutable predecessor/successor event, makes exact generation replay
idempotent, and rejects stale or conflicting adoption. Broker lease transfer
and coordinator saga phases remain outside this package.

## Release and consumption

Releases are compiled JavaScript and declarations published from an annotated
`session-supervisor-v<version>` tag whose target is reachable from reviewed
`origin/main`. Consumers pin an exact package version and retain the package
integrity in their lockfile. Moving Git branches and workspace-path dependencies
are unsupported.
