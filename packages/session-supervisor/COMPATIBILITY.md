# Session Supervisor compatibility policy

`@grubbyhacker/session-supervisor` is released as compiled JavaScript and
declarations from an immutable annotated Git tag. Consumers must pin one exact
package version and retain the resolved package integrity in their lockfile;
they must not import a Fleet branch, workspace path, source copy, or version
range.

The `1.x` line supports exactly `agentd/v1`. Backward-compatible additions may
ship in a new `1.x` release. Any command, event, replay, persistence, or
runtime-port change that would make an existing `agentd/v1` journal ambiguous
requires a new protocol version and a new major package release.

Consumers record the upstream tag, commit SHA, exact package version, and
lockfile integrity in their own repository. An update must be a reviewed commit
that refreshes those values and runs the upstream package tests together with
the consumer's compatibility tests.

The package remains deliberately free of Fleet daemon routing, target,
credential, worktree, or process authority. A consuming runtime owns its
authenticated transport, durable journal implementation, runtime adapter,
isolation primitive, and completion verifier.
