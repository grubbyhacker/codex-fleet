# Engineering Hygiene: Public Readiness Slice

## Scope

- Targeted slice: make repository hygiene and developer-facing validation commands coherent, stable, and documented for public contributors.
- Scope: root tooling scripts, command documentation, and hygiene status tracking.
- Non-scope: application feature changes, architecture refactors, and design changes in `docs/DESIGN.md`.

## Current Tooling Baseline

### Runtime

- `mise` for tool bootstrap and pinning (`bun@1.3.14` in `mise.toml`).
- `bun` as package manager, script runner, test runner, and lockfile engine.

### Build / Packaging

- `bun run build:bin` runs the local binary packaging script (`scripts/build-bin.ts`).
- `bun run install:bin` builds and installs CLI/MCP/daemon/TUI binaries.
- `build` alias points to `build:bin` for easier discoverability.

### Type Checking

- `bun run typecheck` uses `tsc -p tsconfig.json --noEmit`.
- Coverage: `tsconfig.json` includes `packages/**/*.ts`, `scripts/**/*.ts`, `test/**/*.ts`.
- `typecheck:watch` added for local iterative checks.
- Decision: keep single TypeScript project for deterministic check behavior across packages.

### Linting

- `bun run lint` uses `eslint .` with `eslint.config.js`.
- `lint:ci` added as explicit CI-facing alias.
- `lint:fix` added for local auto-fix.
- Decision: keep ESLint as the canonical linter (no additional parallel tool).

### Formatting

- `bun run format:check` uses `prettier --check .`.
- `bun run format` and `format:write` remain available to write changes.
- `.prettierignore` excludes generated/runtime artifacts.

### Tests

- Unit tests: `bun run test:unit` (`test/schema/**/*.test.ts`).
- Integration tests: `bun run test:integration` (`test/integration/**/*.test.ts`).
- E2E: `bun run test:e2e:codex` gated by `CODEX_FLEET_RUN_CODEX_E2E=1`.
- `bun run test` maps to `bun run test:all` for default local gate.
- `bun run test:all` executes unit + integration.
- `bun run test:all-raw` retained as an explicit “run everything” fallback for ad-hoc verification.

### Combined Validation

- `bun run check` is the primary gate and runs:
  - typecheck
  - lint
  - format:check
  - test:all

## Identified Gaps / Risks Before This Slice

1. No single file described the script contract for local/public contributor validation.
2. Command discoverability around test subsets and fix/build intent was fragmented.
3. The default test command did not explicitly communicate the project’s fast-vs-gated test split.

## Slice Decisions

1. Keep a single root command surface with focused aliases, rather than introducing additional tooling (e.g., Husky, Nx/Turbo, additional lint/format frameworks).
2. Preserve backward compatibility for existing commands where possible.
3. Use explicit command names (`test:unit`, `test:integration`, `test:e2e:codex`, `test:all`, `lint:fix`) to improve public usability.
4. Do not alter `docs/DESIGN.md`; this slice is operational hygiene only.

## Validation Commands (to be used by contributors and CI)

- `mise exec -- bun install`
- `mise exec -- bun run check`
- `mise exec -- bun run test:e2e:codex` (opt-in)

## Follow-up Checklist

- [ ] Add a tiny CI status badge in documentation if a public-hosted CI workflow is added in this phase.
- [ ] Decide whether `test:all` should include `test:all-raw` when repository-level non-gated suites stabilize.
- [ ] Add a short preflight check for required external tools beyond Bun (if any) before check scripts are documented for external contributors.

## Iteration Trigger

If `mise exec -- bun run check` is not green in CI due to environment-specific failures, the next iteration should:

1. Add targeted environment guards to unstable tests.
2. Split the failing command surface into a fast local profile and a CI profile.
3. Record the final decision in the same file before changing command defaults.
