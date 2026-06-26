# Public Publication Checklist

Use this checklist before switching the GitHub repository from private to public.

## Required PRs

- Safety correctness: active tasks cannot have resources released underneath them.
- Public docs: README, SECURITY.md, and the v1 authentication model describe the current risk posture.
- Public artifact cleanup: accidental local absolute paths and generated filesystem noise are removed; handoff logs and real repo references are intentionally retained as publication context.
- Local socket hardening: daemon socket connections verify the peer UID where the runtime exposes socket credentials.
- Release posture: package metadata, private npm posture, and final checks are explicit.

## Final Local Checks

Run from a clean worktree after the readiness PRs are merged:

```sh
mise install
mise exec -- bun install
mise exec -- bun run public:check
```

Optional real-worker smoke:

```sh
CODEX_FLEET_RUN_CODEX_E2E=1 mise exec -- bun run test:e2e:codex
```

## Sensitive Content Review

`public:check` runs the pinned `gitleaks` scanner from `mise.toml`.

For an additional prose-oriented review, run:

```sh
rg -n -i "(api[_-]?key|secret|password|private[_-]?key|BEGIN .*PRIVATE KEY|github_pat_|ghp_|sk-[A-Za-z0-9_-]{20,})" . -g '!node_modules' -g '!bun.lock'
```

The scanner can also be run directly:

```sh
mise exec -- gitleaks detect --source . --no-banner --redact
```

Review any matches manually. Prose about secrets, test fixture strings, and security documentation are expected false positives.

## Git History

Current cleanup removes sensitive or distracting material from the public tree, not necessarily from historical commits. If historical local paths or old private rollout examples are unacceptable, publish by creating a fresh public repository from a clean export or rewrite history before changing visibility.

Do not rewrite history merely to remove harmless local paths unless the paper/release plan requires a clean historical artifact.

## Publication Step

Only switch repository visibility after:

- all required PRs are merged;
- checks pass on `main`;
- dependency audit passes;
- sensitive-content review is complete;
- the README states the project is local, single-operator, broad-access, and not a supported public product.

The npm package posture remains private. Public GitHub visibility does not imply npm publication.
