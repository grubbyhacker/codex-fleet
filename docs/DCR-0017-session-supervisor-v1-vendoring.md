# DCR-0017: Session supervisor v1 source-vendoring release

Status: Superseded by DCR-0018

## Decision

The existing session-supervisor spike is released as
`@codex-fleet/session-supervisor` version `1.0.0` at an annotated immutable
Git tag. It remains a source-vendored library, not a registry dependency and
not a Fleet daemon dependency.

Production consumers must vendor only a resolved release tag and commit SHA,
record the package version and source digest, and retain the compatibility
policy beside the vendored source. They must never copy from an unversioned
Fleet branch or use the local Fleet workspace as an installation dependency.

## Compatibility

The `1.x` line is compatible with `agentd/v1`. Backward-compatible additions
may use a new `1.x` release. A breaking command, event, replay, persistence,
or runtime-port change requires a new `agentd` protocol version and a major
package release. Consumers update through reviewed source-vendoring commits
that run upstream and consumer compatibility tests.

## Consequences

This creates a stable adoption boundary without publishing Fleet internals or
coupling worker deployments to the Fleet monorepo. `agentd` remains responsible
for its authenticated protocol, durable storage, runtime adapter, isolation,
and verifier; the vendored library supplies only the reviewed logical-session
contract.
