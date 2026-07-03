# DCR-0010: Agent Environment Friction Logging

## Context

Fleet workers need an agent toolbox that is broader than a target repo's build and test toolchain. A repo worker may still need YAML, secret-storage, archive, HTTP, or cloud inspection tools to complete a task around the repo. Putting those tools into each repo's `mise.toml` would confuse project dependencies with agent execution needs, while leaving them implicit makes workers repeatedly discover missing commands or libraries and invent fallbacks.

## Decision

Fleet records agent environment friction as task history evidence before it tries to solve tool provisioning. After a worker run, the daemon detects missing commands, missing runtime modules, and explicit worker-reported fallbacks in the retained final response, worker stderr, and worker startup errors. Each unique signal is appended as an `environment_friction` task event.

Workers are also instructed to include a concise final-response line beginning with `Fleet environment friction:` when they work around a missing useful command, parser, library, or module.

This DCR does not introduce automatic installation, profile promotion, or new public API methods. Those belong in a later design once recurring friction is visible.

## Consequences

- Operators can inspect task history to see concrete evidence for future agent toolbox profiles.
- The first implementation stays auditable and avoids unreviewed package installation.
- Detection is best-effort and text-based, so missed or false-positive signals are acceptable in exchange for low operational risk.
- Tool availability remains separate from credential or authority grants.
