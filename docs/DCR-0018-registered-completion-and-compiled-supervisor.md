# DCR-0018: Registered completion and compiled session supervisor

Status: Accepted
Date: 2026-07-16

## Context

Fleet's immutable design record correctly keeps its public task lifecycle at
operational facts: a Fleet worker exit, branch, PR, or CI reference is not
proof that arbitrary product work is semantically complete. DCR-0007 added a
narrow daemon-owned repair loop for Fleet delivery hygiene. The session
supervisor spike later demonstrated a smaller backend-neutral append/replay
contract, but DCR-0017 released it only as source to vendor.

A managed consumer needs to prove a registered repository task with objective
evidence, bounded continuation, cumulative resource accounting, and exact
worker adoption. It must not import Fleet target management,
credentials, worktree cleanup, desktop state, or host shell authority.

## Decision

`@grubbyhacker/session-supervisor` 1.1 adds neutral, strict primitives alongside
the compatible `agentd/v1` session API:

- a compiled registry maps a task kind to one strict parameter schema,
  completion contract, verifier identity, canonical SHA-256 contract digest,
  bounded reason-code set, and cumulative budget;
- verifier results are limited to `satisfied`, `missing_or_stale`,
  `continuation`, or `escalated`, exact contract and task-evidence digests,
  revision identity, bounded reason codes, and opaque evidence references;
- deterministic continuation inputs sort registered reason codes and never
  interpolate verifier prose;
- journal-ready budget events reserve a turn before invocation, account exact
  usage idempotently, and require an explicit within-budget decision before a
  satisfied verifier result may be accepted;
- an atomic adoption reducer validates the complete predecessor lineage and
  policy binding, advances exactly one fence epoch, makes exact replay
  idempotent, and rejects stale or conflicting generations. It consumes the
  broker wire without transforms: lowercase 32-hex lineage IDs and a lowercase
  bare 64-hex policy digest.

The package does not implement broker lease transfer or the coordinator saga.
It supplies only agentd's atomic adoption primitive; each external saga phase
and routing barrier stays in its owning service. Runtime adapters, verifier
implementations, credential custody, transport authentication, storage,
janitorial classification/execution, and resource enforcement also stay with
the consumer.

Fleet's public daemon remains an operational task supervisor. Its existing
worktree postchecks and DCR-0007 repair prompts are not registered completion
verifiers. The two meanings therefore do not conflict: generic Fleet tasks do
not acquire semantic-completion inference, while a separate consumer may use
the explicit registered contract and objective evidence surface.

## Distribution and compatibility

DCR-0017's source-vendoring decision is superseded. Version 1.1 is published as
compiled JavaScript plus declarations from an annotated
`session-supervisor-v<version>` tag. Release automation requires the tag version
to equal the manifest, the tag object to be annotated, and its target to be
reachable from reviewed `origin/main`; the package registry rejects reuse of an
existing exact version. Release tags are immutable by policy and must not be
moved or deleted.

Consumers use an exact package version and lockfile integrity. Moving branches,
workspace paths, uncompiled source copies, and version ranges are unsupported.
Compatible additions remain in `1.x`; an ambiguous replay, command, event,
persistence, or runtime-port change requires a new protocol and package major.

## Consequences

- Registered consumers can prove semantic completion without making Fleet a
  second general-purpose orchestrator.
- Callers cannot select verifier code or inject verifier commands through task
  parameters, outcomes, or continuation text.
- Budget exhaustion and stale evidence fail closed and preserve consumer-owned
  workspace/evidence for reconciliation.
- Fleet-specific cleanup, credentials, targets, and broad shell authority do
  not enter the shared package.
