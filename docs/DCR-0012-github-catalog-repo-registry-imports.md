# DCR-0012: GitHub Catalog Repo Registry Imports

Status: Accepted
Date: 2026-07-04

## Context

Codex Fleet has a local repo registry at `~/.codex-fleet/repos.json`. The
VPS ops repository also manages GitHub repository intent in
`config/github/repositories.json` for OpenTofu. Keeping these lists separate
creates drift: a repository can be tracked by VPS ops without being available as
a Fleet target on the same machine.

The Fleet registry still needs Fleet-specific fields such as verify commands,
model tier, mirror path, and merge guidance. Those fields do not belong in the
VPS ops GitHub IaC catalog.

## Decision

Fleet repo registries may import GitHub repository catalogs with a
`githubRepositoryCatalogs` array in `repos.json`. Imported catalog entries become
normal Fleet repo targets with:

- alias from the GitHub repository name;
- remote URL rendered from the catalog owner and a configurable template;
- default branch from catalog settings, defaulting to `main`;
- branch protection inferred from branch protection or default-branch rulesets;
- a catalog-level default model tier.

Native `repos` entries remain supported and overlay imported entries by alias.
That keeps Fleet-specific settings local while making the VPS ops GitHub catalog
the source for repository presence.

Catalog paths may use `~`, `$NAME`, and `${NAME}` expansion. Machine-specific
workspace locations should live in environment configuration rather than being
hard-coded in committed examples or reusable registry templates.

## Consequences

- A repository tracked by VPS ops can appear in Fleet without duplicate native
  Fleet source configuration.
- Fleet-specific verify commands and model choices remain in the Fleet registry.
- Archived GitHub catalog repositories are excluded by default.
- Registry loading now depends on any configured external catalog files being
  present and parseable on the local machine.

## Implementation Sketch

1. Extend the repo registry file schema with `githubRepositoryCatalogs`.
2. Load catalog entries first, then overlay explicit `repos` entries.
3. Keep the existing native `repos` schema compatible for standalone Fleet use.
4. Use the shared registry loader anywhere Fleet needs repo source resolution,
   including CLI cleanup paths.
