# DCR-0013: Explicit Model Routes

Date: 2026-07-11

## Context

Fleet originally exposed `modelTier` as a coarse cost/capability hint:
`cheap`, `standard`, or `strong`. That was enough while concrete Codex model
selection could mostly inherit the operator default. GPT-5.6 introduced a
family of explicit Codex model choices: Sol, Terra, and Luna. Fleet should use
Terra by default while preserving explicit routes for conservative fallback,
fast narrow work, and strongest-model work.

## Decision

Add optional `modelRoute` to `delegate_task`:

- omit or `fleet-default`: Fleet default route, currently `gpt-5.6-terra`
- `gpt-5.5`: explicit GPT-5.5 route
- `gpt-5.6-luna`: fastest/lowest-cost GPT-5.6 route
- `gpt-5.6-terra`: explicit spelling of the default balanced GPT-5.6 route
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

Fleet defaults to GPT-5.6 Terra while keeping explicit GPT-5.5 and alternate
GPT-5.6 routes available. The extra persisted fields make it possible to detect
whether orchestrators are over-selecting `gpt-5.6-sol`.
