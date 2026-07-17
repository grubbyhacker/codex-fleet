# Session Supervisor compatibility policy

`@grubbyhacker/session-supervisor` is released as compiled JavaScript and
declarations from an immutable annotated Git tag. Consumers must pin one exact
package version and retain the resolved package integrity in their lockfile;
they must not import a Fleet branch, workspace path, source copy, or version
range.

The `1.x` line is retained only as historical release metadata. The `2.x` line
uses the strict `session-supervisor/journal/v2` persisted contract and protects
the behavioral invariants in DCR-0019 rather than preserving the `1.x`
TypeScript or consumer transport surface. Any journal interpretation that would
make replay ambiguous requires a new journal version and package major.

Legacy `agentd/v1` journals migrate forward through
`LegacyAgentdV1JournalReader`. `LegacyDeferredVerifierAdapter` and
`LegacyTokenUsageAdapter` conservatively reconcile historical verifier and
usage gaps; they cannot authorize new work or synthesize success. Their
deletion gates are normative in DCR-0019. Unknown or conflicting source,
migration, and future journal versions fail closed.

Consumers record the upstream tag, commit SHA, exact package version, and
lockfile integrity in their own repository. An update must be a reviewed commit
that refreshes those values and runs the upstream package tests together with
the consumer's compatibility tests.

The package remains deliberately free of Fleet daemon routing, target,
credential, worktree, or process authority. A consuming runtime owns its
authenticated transport, durable journal implementation, runtime adapter,
isolation primitive, and completion verifier.
