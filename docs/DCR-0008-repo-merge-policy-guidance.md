# DCR-0008: Repo Merge Policy Guidance

Status: Accepted
Date: 2026-06-30

## Context

Fleet workers run with the operator's ambient credentials. In practice, that means a worker asked to complete `full_delivery` can often merge its own PR, even when the operator only wanted a ready PR and passing checks.

Credential-scoped enforcement belongs in a later broker/sandbox profile, but Fleet can make the intended boundary explicit now.

## Decision

Repo registry entries may set `mergePolicy`:

- `human_review`: workers may push branches and open/update ready PRs, but must stop before merge.
- `agent_merge_explicit`: workers may merge only when the task prompt explicitly instructs them to merge that PR.
- `agent_merge_allowed`: workers may merge when the delivery mode, prompt, repo rules, and checks allow it.

If omitted, protected repos default to `human_review`; unprotected repos default to `agent_merge_explicit`.

Fleet exposes the policy in target descriptors and injects it into worker instructions and delivery repair prompts. This is soft policy guidance, not hard credential enforcement.

## Consequences

- Protected repos default to human review without changing public task tools.
- Orchestrators can still request `full_delivery`, but workers in human-review repos stop at a ready PR plus check status.
- True prevention of merges still requires credential separation or broker-enforced GitHub permissions.
