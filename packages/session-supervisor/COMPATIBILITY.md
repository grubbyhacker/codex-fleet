# Session Supervisor compatibility policy

`@codex-fleet/session-supervisor` is released as a source-vendored protocol
library. Consumers must pin an immutable annotated Git tag and its resolved
commit SHA; they must not import a Fleet branch, workspace path, or moving
package version.

The `1.x` line supports exactly `agentd/v1`. Backward-compatible additions may
ship in a new `1.x` release. Any command, event, replay, persistence, or
runtime-port change that would make an existing `agentd/v1` journal ambiguous
requires a new protocol version and a new major package release.

Consumers vendor the package source plus this file and record the upstream tag,
commit SHA, package version, and content digest in their own repository. An
update must be a reviewed commit that refreshes all of those values and runs
the upstream package tests together with the consumer's compatibility tests.

The package remains deliberately free of Fleet daemon routing, target,
credential, worktree, or process authority. A consuming runtime owns its
authenticated transport, durable journal implementation, runtime adapter,
isolation primitive, and completion verifier.
