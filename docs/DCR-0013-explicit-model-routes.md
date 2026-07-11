# DCR-0013: Explicit Model Routes

Date: 2026-07-11

## Context

Fleet originally exposed `modelTier` as a coarse cost/capability hint:
`cheap`, `standard`, or `strong`. That was enough while concrete Codex model
selection could mostly inherit the operator default. GPT-5.6 introduced a
family of explicit Codex model choices: Sol, Terra, and Luna. Orchestrators need
a way to request those models without making the whole fleet default to GPT-5.6.

## Decision

Add optional `modelRoute` to `delegate_task`:

- omit or `fleet-default`: Fleet default route, currently `gpt-5.5`
- `gpt-5.5`: explicit GPT-5.5 route
- `gpt-5.6-luna`: fastest/lowest-cost GPT-5.6 route
- `gpt-5.6-terra`: balanced GPT-5.6 route
- `gpt-5.6-sol`: strongest GPT-5.6 route

Keep `modelTier` as the risk/capability hint. Persist both tier and route
choices on task snapshots:

- `requestedModel`, `actualModel`
- `requestedModelRoute`, `actualModelRoute`
- `workerModel`, `workerReasoningEffort`

Emit `model_route` events when an orchestrator explicitly requests a model route
or when route fallback occurs, so Sol/Terra/Luna selection can be audited from
history as well as snapshots.

## Consequences

Fleet stays on GPT-5.5 by default while allowing explicit GPT-5.6 use. The
extra persisted fields make it possible to detect whether orchestrators are
over-selecting `gpt-5.6-sol`.
