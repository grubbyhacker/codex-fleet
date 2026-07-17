# DCR-0020: Canonical runtime and projection records

Status: Accepted
Date: 2026-07-17

## Context

DCR-0019 makes `session-supervisor/journal/v2` the sole durable authority and
allows consumer transport APIs to change. Consumer compilation against 2.0.0
found three places where its strict schema could not truthfully preserve the
normative behavior:

- a new canonical journal could authorize effects but could not record the
  durable session identity needed to interpret those effects after restart;
- an effect completion could bind a digest but not the opaque result reference
  or backend conversation identity used by the consumer projection; and
- exact usage and its cumulative budget update could not be committed in the
  same completion transaction.

Using a second consumer event log would make that log authoritative. Encoding
transport events as unrelated canonical effect kinds would make the journal
syntactically valid but semantically false. Both violate DCR-0019.

## Decision

The journal-v2 vocabulary gains additive, strict records for the missing
durable facts:

- `session_opened` records immutable session, worker, lineage, and workspace
  identity, including the authority profile version and policy digest needed to
  validate later fence adoption. It does not grant provider, repository, or
  credential authority.
- `session_checkpointed` records an opaque checkpoint reference.
- `session_terminal` and `turn_terminal` record cancellation or termination so
  replay and late-result rejection do not depend on a transport log.
- `effect_completed` may carry an opaque result reference, backend conversation
  identity, exact six-dimensional usage, and the matching cumulative
  `usage_recorded` budget event in one record. New runtime effects also bind a
  durable turn identity and the worker fence that authorized them. Satisfied
  decisions bind a durable decision time so the cumulative deadline can be
  recomputed during replay.
- A completion decision binds the exact model turn and the completed verifier
  digest for that turn. A deterministic continuation may follow either the
  `missing_or_stale` or `continuation` verifier outcome defined by the
  registered contract; it cannot borrow a decision from another turn with the
  same task snapshot.
- The one same-depth fresh invocation is authorized only after the predecessor
  completion durably records `missing_backend_thread`. Its reservation carries
  `retryCause: missing_backend_thread`; the budget primitive and journal reducer
  both reject an uncaused or mismatched same-depth reservation.

The model-turn authorization remains the source of task, reservation, and
idempotency authority. Registered task parameters and opaque references remain
the durable input; the package does not add caller-selected commands, provider
configuration, credentials, URLs, mounts, or shell authority.

Consumers reconstruct their transport view from canonical records. A consumer
may name a temporary projection adapter, but it may not persist another
authoritative event stream.

The 2.1 reader continues to accept strict records emitted by 2.0. A 2.0 effect
without the new turn/fence/accounting fields is replayed only into explicit
reconciliation state and cannot support a new satisfied decision. This keeps
the journal version forward-compatible without treating incomplete historical
records as new authority.

Model invocation ordinal and verifier-continuation depth are distinct. The one
fresh invocation after a missing backend thread receives its own reservation at
the same continuation depth; only a verifier-created continuation advances the
depth.

## Compatibility matrix amendment

| Required behavior                                          | 2.0.0 gap                               | Canonical record                                            | Required negative proof                                           |
| ---------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Restart interprets new effects in the same logical session | No new-session record                   | `session_opened`                                            | Effect before open and conflicting reopen fail closed             |
| Checkpoint and terminal authority survive restart          | No canonical terminal/checkpoint record | `session_checkpointed`, `session_terminal`, `turn_terminal` | Late completion after terminal fails closed                       |
| Exact result and conversation identity survive replay      | Completion carried only a digest        | Extended `effect_completed`                                 | Digest/reference or conversation conflict fails closed            |
| Usage and cumulative budget are atomic                     | No legal post-completion budget update  | `effect_completed.usage` plus matching `usage_recorded`     | Missing, mismatched, duplicate, and conflicting usage fail closed |
| Transport compatibility is non-authoritative               | Consumer needed a second event log      | Canonical reducer projection                                | Restart from canonical records alone produces the same view       |
| Fresh missing-thread retry preserves depth and authority   | Same-depth reservation lacked cause     | Completion outcome plus reservation retry cause             | Uncaused, mismatched, and second fresh retry fail closed          |
| Decisions and continuations bind one exact source turn     | Task-only matching was ambiguous        | Decision turn identity plus completed verifier digest       | Cross-turn decision or continuation borrowing fails closed        |

## Consequences

This is an additive 2.x package release and keeps the journal version at v2.
Older exact package locks continue to read records they produced; they fail
closed on newer event kinds as designed. Consumers that emit the new records
must update their exact package lock first.
