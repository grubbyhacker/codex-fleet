# DCR-0019: Session supervisor behavioral compatibility and journal migration

Status: Accepted
Date: 2026-07-17

## Context

DCR-0018 selected a compiled backend-neutral package and initially described
compatibility in terms of the `1.x` API and the `agentd/v1` command and event
surface. Consumer development subsequently added worker binding, token usage,
runtime failure, and reassignment behavior to a source-vendored fork while the
compiled package added registered completion, cumulative budgets, and atomic
adoption as separate primitives. Preserving either set of exported symbols as
the architectural contract would preserve two incomplete compositions and make
their accidental TypeScript shapes more durable than their safety properties.

The durable compatibility boundary is instead the behavior that must survive a
restart, crash, retry, reassignment, or package upgrade. Persisted journals need
an explicit migration contract; in-memory class and method names do not.

## Decision

The next compiled release is a new package major. It defines one canonical
journal format, `session-supervisor/journal/v2`, independently of any
consumer's transport protocol. The package may replace `1.x` commands, events,
ports, classes, and method names. Consumers adapt their transport and runtime
interfaces at their own boundary and pin the exact package version and
integrity.

### Target behavioral contract

The canonical supervisor composition preserves these invariants:

1. **Durability precedes effect.** A runtime, verifier, continuation, adoption,
   or janitorial effect cannot begin until the journal has durably recorded the
   authorization or reservation for that exact effect. A failed append leaves
   live and replayed state unchanged.
2. **One atomic logical transition.** State needed to interpret a runtime
   attempt and its budget reservation, a verifier decision and its evidence,
   or a continuation and its parent terminal state is committed as one journal
   transaction. Replay cannot observe a half-transition.
3. **Replay never invents work.** A crash or restart reconstructs state from
   the journal without silently invoking a model, verifier, or cleanup effect.
   An indeterminate authorized effect becomes reconciliation state unless its
   exact idempotency contract proves that retry is safe.
4. **Terminal authority wins.** Cancellation, termination, and a newer worker
   fence reject late results from an older or in-flight attempt.
5. **Every model invocation is reserved.** Initial turns, deterministic
   continuations, and the single fresh invocation allowed after a missing
   backend thread each consume a distinct durable model-turn reservation before
   provider invocation. Missing-thread recovery is bounded to one fresh
   attempt in the same logical session and workspace and cannot loop.
6. **Usage is exact and idempotent.** Provider-reported input, cached-input,
   output, reasoning-output, total-token, and runtime measurements are recorded
   against an attempt identity. Exact replay is a no-op; conflicting replay
   fails closed. A satisfied completion requires an explicit within-budget
   decision over cumulative usage.
7. **Completion is registered and objective.** A verifier identity, strict task
   parameters, completion contract, allowed reason codes, and budget are fixed
   by a compiled registry. A satisfied decision must bind the exact task,
   contract digest, evidence revision, and verifier identity. Stale or
   mismatched evidence cannot satisfy the task.
8. **Continuation is deterministic.** Continuation input is derived from the
   registered task and canonically sorted reason codes. Verifier prose, shell
   commands, and caller-selected verifier code never enter continuation input.
9. **Reassignment preserves lineage.** Adoption validates the complete durable
   predecessor, advances exactly one fence epoch, preserves the logical session
   and storage lineage, makes exact generation replay idempotent, and rejects a
   stale or conflicting predecessor. Broker lease transfer and routing barriers
   remain outside the package.
10. **Cleanup is token free and conservative.** Janitorial planning and
    execution do not invoke a model. Dirty, unreported, associated, or
    ambiguous repository state is preserved for reconciliation. Cleanup is a
    two-phase planned/applied transition whose replay cannot widen its target.
11. **Authority remains outside.** Credentials, provider selection, repository
    registration, transport authentication, storage implementation, process
    isolation, and host shell authority remain consumer-owned. Journal data
    carries opaque references, not credentials.
12. **Unknown state fails closed.** Unknown journal versions, event kinds,
    registry digests, fence generations, or migration states are rejected
    without runtime, verifier, adoption, or cleanup effects.

These invariants are normative. Exported TypeScript names and consumer HTTP
shapes are not, except for the versioned journal schemas and migration functions
that interpret persisted data.

### Journal migration contract

Migration is explicit and forward-only:

- `agentd/v1` rows remain immutable source records. Migration writes canonical
  `session-supervisor/journal/v2` records and a migration manifest; it never
  updates or deletes the source rows.
- The manifest binds the source protocol, source row count, ordered source
  digest, target journal version, target row count, ordered target digest, and
  migration implementation identity. It is written in the same transaction as
  the target rows becoming active.
- Migration is deterministic and idempotent. Repeating it with the same source
  and implementation returns the existing manifest. A changed source, changed
  output, partial target, or conflicting manifest fails closed.
- The active-journal pointer changes only after every target record validates
  and replay produces the expected terminal snapshot. A crash before that
  transaction leaves the source active; a crash after it leaves the complete
  target active.
- Unknown source versions and future canonical versions are not guessed or
  coerced. Rollback means selecting the still-immutable source journal before
  new canonical effects have been admitted, not reverse-migrating new events.
- Defaults are allowed only when the prior format unambiguously omitted a value
  and the default cannot grant authority or report success. Such defaults are
  recorded as migration facts. Missing evidence, usage, reservation, or
  janitorial authorization never defaults to a successful state.

### Named temporary adapters

Only these temporary compatibility adapters are allowed:

| Adapter                         | Temporary responsibility                                                                                                                                                                                                                      | Deletion criterion                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LegacyAgentdV1JournalReader`   | Strictly parse immutable `agentd/v1` source rows and expose them only to the forward migrator. It cannot append, invoke effects, or accept unknown event kinds.                                                                               | Delete after every managed journal has a validated canonical manifest, the rollback window has expired, retained backup policy no longer requires v1 replay, and the managed lifecycle proves zero v1-reader activations. |
| `LegacyDeferredVerifierAdapter` | Convert the historical unconfigured verifier outcome into canonical reconciliation state for pre-migration attempts. It cannot emit `satisfied`, create a continuation, or evaluate new work.                                                 | Delete after all active journals are canonical, no retained active attempt lacks a registered task snapshot, and the negative matrix proves legacy verifier input is rejected at task admission.                          |
| `LegacyTokenUsageAdapter`       | Map unambiguous historical token fields into canonical usage and record an explicit `runtime_measurement_unavailable` migration fact when elapsed runtime was not persisted. It cannot synthesize positive usage or a within-budget decision. | Delete after all active journals contain canonical per-attempt usage records and the supported retention window contains no legacy attempt eligible for replay.                                                           |

Adapter names describe the legacy boundary they isolate, never a transient
project phase. New compatibility exceptions require another DCR with a narrow
responsibility and an independently testable deletion criterion.

## Compatibility matrix

| Contract area                        | Compiled `1.1` candidate                                                               | Current source-vendored consumer                                       | Canonical target                                                                                  | Migration or adapter                                                            | Required proof                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Append-before-effect                 | Session events append before runtime invocation                                        | Preserved, including fenced SQLite append                              | Atomic authorization or reservation precedes every external effect                                | Direct canonical migration                                                      | Inject append failure at each seam; assert no effect and identical replay state                        |
| Atomic composition                   | Runtime lifecycle is journaled; registered budget and verifier primitives are separate | Runtime lifecycle is journaled; registered primitives are not composed | Attempt, reservation, usage, verifier, and continuation transitions have one transaction boundary | Migrator groups only transitions that are unambiguous; otherwise reconciliation | Crash at every transition boundary and compare live state with replay                                  |
| Model-turn budget                    | Budget primitive exists but missing-thread retry is outside it                         | Retry can make a second invocation without a second reservation        | Every provider call has its own durable reservation; recovery is bounded once                     | No success-default; unresolved legacy attempt reconciles                        | Negative test for unreserved initial, continuation, and recovery calls                                 |
| Usage accounting                     | Registered accounting lacks cached/reasoning token fields                              | Exact token dimensions exist; runtime duration is absent               | Exact per-attempt token dimensions plus runtime, idempotently accumulated                         | `LegacyTokenUsageAdapter`                                                       | Exact replay no-op; conflict rejected; cumulative limit enforced                                       |
| Registered completion                | Strict registry and evidence-bound verifier result exist                               | Repository verifier exists beside a deferred supervisor verifier       | Registered snapshot and exact evidence binding gate satisfaction                                  | `LegacyDeferredVerifierAdapter` for old attempts only                           | Stale digest, stale revision, unknown reason, and unregistered task all fail closed                    |
| Deterministic continuation           | Primitive exists outside the session supervisor                                        | Supervisor continuation uses verifier facts                            | Only sorted registered reason codes influence continuation                                        | Legacy continuations remain historical; no translation into new prompts         | Prove prose/command injection cannot change continuation bytes                                         |
| Missing backend thread               | One fresh attempt is bounded                                                           | Bounded, but not independently budget-reserved                         | One fresh attempt, same lineage/workspace, separate reservation                                   | Legacy in-flight recovery becomes reconciliation if reservation is absent       | Missing-thread success plus repeated-missing negative case                                             |
| Cancellation and termination         | Late-result rejection is present                                                       | Present and combined with attempt revocation                           | Terminal state and newer fence reject all late results                                            | Direct canonical migration                                                      | Race cancellation, termination, and reassignment against completion                                    |
| Reassignment                         | Atomic adoption reducer exists separately                                              | Durable rebind command/event and fence validation exist                | One lineage-preserving, monotonic, idempotent adoption transition                                 | Translate only exact durable predecessor/successor events                       | Exact replay succeeds; stale/conflicting generation and late result fail                               |
| Janitorial lifecycle                 | Classification/execution intentionally consumer-owned                                  | Token-free repository janitor exists beside the journal                | Canonical planned/applied records bind exact target and conservative classification               | No legacy cleanup authorization is inferred                                     | Crash between plan/apply; dirty, unreported, associated, and ambiguous negatives preserve state        |
| Journal interpretation               | Strict `agentd/v1` union                                                               | Extended strict `agentd/v1` union in append-only SQLite rows           | Strict `session-supervisor/journal/v2` plus manifest                                              | `LegacyAgentdV1JournalReader`                                                   | Golden-journal migration, repeated migration, tamper, partial, and future-version negatives            |
| Public API surface                   | `1.1` exports session and registered primitives                                        | Consumer fork exports extra fields, errors, and methods                | Consumer adapters may use new names and composition                                               | No general API shim                                                             | Compile and lifecycle proof use only the exact released package; no vendored supervisor source remains |
| Credentials and production authority | Excluded                                                                               | Consumer-owned                                                         | Excluded; production remains separately gated                                                     | None                                                                            | Credential-independent lifecycle passes and production target is unreachable                           |

## Release and deletion gates

The canonical package is publishable only after its golden migration fixtures,
crash matrix, negative matrix, and compiled-consumer tests pass. A consumer must
pin the exact major version and registry integrity; a vendored supervisor copy,
workspace dependency, moving reference, or version range invalidates the proof.

Adapter deletion is a release gate, not aspirational cleanup: each managed
proof records adapter activation counts and the journal-version census. An
adapter may be removed only when its table criterion is evidenced under one
exact package, consumer, topology, and fixture lock.

## Consequences

- Compatibility protects safety and lifecycle behavior without freezing an
  accidental pre-release TypeScript surface.
- Persisted state has a reviewable, crash-safe transition instead of permissive
  schema defaults or dual interpretation.
- The new package major is deliberate even if some exported names happen to
  remain unchanged.
- Temporary compatibility code is visible, bounded, and removable by evidence.
