# Documentation Readiness Audit: codex-fleet public consumption

Date: 2026-06-24  
Owner: codex-fleet publication documentation slice  
Scope: Public-facing documentation, install/runtime assumptions, MCP/TUI/CLI usage, safety boundaries, stale statements

## Audit objective

Create a durable tracker for gaps that block first-time public users from understanding:

- what codex-fleet is,
- how to install/run/use it,
- which pieces are local/private vs shared assumptions,
- how to perform basic validation, and
- what is intentionally not guaranteed for safety or multi-tenant use.

## Gap inventory (before this slice)

### Public entrypoint (`README.md`)

1. Missing explicit statement that codex-fleet is single-operator, local-only, and not multi-tenant.
2. Runtime assumptions were present but spread across sections (paths, daemon lifecycle, bootstrap expectations).
3. MCP/TUI/CLI usage existed but was not consistently grouped by operator flow.
4. No single validation checklist for first-run checks (`--probe`, daemon startup, CLI readback, cleanup).
5. Shell safety implications were implied but not explicitly framed as local-boundary guidance.

### Design and plan docs

1. `docs/DESIGN.md` is the correct architectural source, but users are not currently directed there as the “large architecture” source.
2. `docs/CODE_WALKTHROUGH.md` had not yet been introduced; this gap is now closed.
3. `docs/PRODUCTIONIZATION_PLAN.md` contains rollout steps and private example aliases; these are internal operational specifics, not public-first getting-started guidance.

### Stale or ambiguous statements

1. Multiple docs mix “what it is” and “deployment plumbing” in the same section, which can obscure public-facing onboarding.
2. Some examples were oriented to internal rollout examples and hard-coded local names rather than public-user-safe, generic setup flow.
3. No explicit callout that `baseCheckout` is compatibility mode rather than primary path.

## Actions taken

- Reworked `README.md` into a public-reader-first structure:
  - Purpose and scope (including local/private boundary),
  - explicit install/bootstrap steps,
  - clear runtime assumptions and workspace layout,
  - explicit MCP adapter identity and tool list,
  - repo/shell target behavior and ownership,
  - operator CLI + TUI usage with common commands,
  - safety boundaries,
  - and a local validation checklist.
- Added explicit architectural reference to `docs/DESIGN.md` and added `docs/CODE_WALKTHROUGH.md` as the dedicated architecture walkthrough.
- Linked operational documents to scope (design vs rollout docs), preserving separation between user semantics and deployment/planning content.

## Status

- Public entrypoint now includes install/run/use guidance and validation flow.
- Safety boundaries are explicit in README.
- No changes were made to design docs content; design intent remains anchored in `docs/DESIGN.md`.

## Remaining risk notes

1. Operational instructions remain macOS-heavy for managed service lifecycle, while manual daemon runtime remains cross-platform.
2. Full MCP client setup still depends on each consumer’s existing MCP app conventions; codex-fleet only documents the adapter contract.
