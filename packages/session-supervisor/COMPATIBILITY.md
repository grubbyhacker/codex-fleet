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

The additive 2.1 records close the new-runtime projection gaps identified by a
compiled consumer: session identity and terminal authority are journal facts,
and exact effect result, conversation, usage, and budget accounting are one
completion transition. Decisions bind one exact model turn and its completed
verifier result. A same-depth fresh invocation additionally requires a durable
`missing_backend_thread` predecessor outcome and matching reservation cause. A
consumer transport log is not a supported compatibility mechanism.

The additive 2.2 `completion_waiting` record is a journal-v2 extension, not a
journal migration: every valid 2.1 journal replays unchanged. A 2.1 consumer
does not recognize the new event kind and must fail closed after a waiting
record; no downgrade adapter is provided or authorized.

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
