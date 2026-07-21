# `@grubbyhacker/session-supervisor`

This package is the compiled backend-neutral core for durable logical sessions.
It supplies strict protocol schemas and pure reducers for append-before-invoke
session state, registered completion contracts, deterministic continuation
inputs, cumulative usage budgets, and exact coordinator adoption.

It deliberately does not contain Fleet targets, worktree cleanup, desktop
management, credentials, provider selection, host shell authority, transport,
storage, runtime adapters, verifier implementations, or janitorial execution.
Those remain responsibilities of the consuming system.

## Behavioral compatibility and journal migration

The canonical persisted contract is `session-supervisor/journal/v2`. It is
independent of a consumer transport API and records atomic effect
authorization, completion, reconciliation, registered completion,
continuation, adoption, and two-phase janitorial transitions. Unknown versions
and event kinds fail closed.

Version 2.2.0 adds `completion_waiting`: a canonical, nonterminal registered
verifier observation bound to the active task, model turn, verifier effect,
session fence, typed observation digest, and fixed poll deadline. Waiting never
reserves or invokes a model turn, changes continuation depth, creates a
continuation input, satisfies a task, or authorizes cleanup. Only an identical
observation-effect replay is idempotent. After waiting, the same active
task/turn/fence may receive another token-free verifier observation or one
terminal decision; stale, conflicting, superseded, and post-terminal records
refuse. Deadline exhaustion is an `escalated` terminal decision without a
continuation.

New-session identity, checkpoint and terminal authority are canonical records,
not consumer transport events. Effect completion atomically binds the opaque
result reference, backend conversation identity, exact token/runtime usage,
and its cumulative budget update. `CanonicalJournalReducer` is the shared pure
live/replay reducer; consumers may project an HTTP view from its snapshot but
must not maintain a second authoritative event log.

`LegacyAgentdV1JournalReader` strictly verifies and parses immutable legacy
rows before `migrateLegacyAgentdV1Journal` produces deterministic canonical
state snapshots and a source/target digest manifest. Legacy unregistered
verifier outcomes and unresolved effects become reconciliation state; the
migration never infers a successful verifier, a missing reservation, or cleanup
authority. Adapter responsibilities and deletion gates are recorded in
DCR-0019.

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

Adoption uses the broker wire identities directly: session and worker-storage
lineages are lowercase 32-hex IDs, while the policy digest is the lowercase
64-hex SHA-256 value without a prefix. The reducer does not add or strip
`sha256:` or otherwise transform these immutable identities.

## Release and consumption

Releases are compiled JavaScript and declarations published from an annotated
`session-supervisor-v<version>` tag whose target is reachable from reviewed
`origin/main`. Consumers pin an exact package version and retain the package
integrity in their lockfile. Moving Git branches and workspace-path dependencies
are unsupported.
