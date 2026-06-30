import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DeliveryMode } from "@codex-fleet/shared";

import { resolveGitExecutable } from "../git.js";
import type { FleetPaths } from "../paths.js";
import type { WorkerInput, WorkerStopHook } from "./backend.js";

const SCRIPT_NAME = "dirty-worktree-stop-hook.sh";
const DEFAULT_MAX_NUDGES = 2;

export function dirtyWorktreeStopHook(
  paths: FleetPaths,
  input: WorkerInput
): WorkerStopHook | undefined {
  if (!shouldInstallDirtyWorktreeStopHook(input)) {
    return undefined;
  }

  const scriptPath = ensureDirtyWorktreeStopHookScript(paths);
  const attemptPath = join(paths.tasksDir, "stop-hook-attempts", `${input.taskId}.attempts`);
  return {
    command: [
      `CODEX_FLEET_STOP_HOOK_ATTEMPTS_FILE=${shellQuote(attemptPath)}`,
      `CODEX_FLEET_STOP_HOOK_DELIVERY_MODE=${shellQuote(input.request.deliveryMode)}`,
      `CODEX_FLEET_STOP_HOOK_MAX_NUDGES=${shellQuote(String(maxNudges()))}`,
      `CODEX_FLEET_GIT_PATH=${shellQuote(resolveGitExecutable())}`,
      shellQuote(scriptPath)
    ].join(" "),
    timeoutSeconds: 10,
    statusMessage: "Checking Fleet worktree"
  };
}

export function shouldInstallDirtyWorktreeStopHook(input: WorkerInput): boolean {
  if (process.env.CODEX_FLEET_STOP_HOOK_ENABLED === "false") {
    return false;
  }
  if (!input.worktreePath || !("repo" in input.request.target)) {
    return false;
  }
  return nudgedDeliveryModes.has(input.request.deliveryMode);
}

export function ensureDirtyWorktreeStopHookScript(paths: FleetPaths): string {
  const scriptPath = join(paths.hooksDir, SCRIPT_NAME);
  mkdirSync(paths.hooksDir, { recursive: true });
  writeFileSync(scriptPath, dirtyWorktreeStopHookScript(), { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

function maxNudges(): number {
  const parsed = Number.parseInt(process.env.CODEX_FLEET_STOP_HOOK_MAX_NUDGES ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_NUDGES;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const nudgedDeliveryModes = new Set<DeliveryMode>([
  "pr_for_review",
  "full_delivery",
  "push_to_main"
]);

function dirtyWorktreeStopHookScript(): string {
  return `#!/bin/sh
set -u

git_path=\${CODEX_FLEET_GIT_PATH:-git}
attempt_file=\${CODEX_FLEET_STOP_HOOK_ATTEMPTS_FILE:-}
delivery_mode=\${CODEX_FLEET_STOP_HOOK_DELIVERY_MODE:-unknown}
max_nudges=\${CODEX_FLEET_STOP_HOOK_MAX_NUDGES:-${DEFAULT_MAX_NUDGES}}

case "$max_nudges" in
  ''|*[!0-9]*) max_nudges=${DEFAULT_MAX_NUDGES} ;;
esac

if ! "$git_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

status=$("$git_path" status --porcelain 2>/dev/null) || exit 0
if [ -z "$status" ]; then
  if [ -n "$attempt_file" ]; then
    rm -f "$attempt_file" 2>/dev/null || true
  fi
  exit 0
fi

if [ "$max_nudges" -le 0 ]; then
  exit 0
fi

attempts=0
if [ -n "$attempt_file" ] && [ -f "$attempt_file" ]; then
  attempts=$(sed -n '1p' "$attempt_file" 2>/dev/null || printf '0')
fi
case "$attempts" in
  ''|*[!0-9]*) attempts=0 ;;
esac

next_attempt=$((attempts + 1))
if [ "$next_attempt" -gt "$max_nudges" ]; then
  exit 0
fi

if [ -n "$attempt_file" ]; then
  mkdir -p "$(dirname "$attempt_file")" 2>/dev/null || true
  printf '%s\\n' "$next_attempt" > "$attempt_file" 2>/dev/null || true
fi

dirty_files=$(printf '%s\\n' "$status" | sed '/^$/d' | wc -l | tr -d ' ')
case "$delivery_mode" in
  pr_for_review)
    guidance='This pr_for_review task must not stop with a dirty worktree. Do not discard intended changes. Stage and commit intended work, push the branch, open or report the PR URL, then stop with a clean worktree. If blocked, report git status --short and the exact blocker.'
    ;;
  full_delivery)
    guidance='This full_delivery task must not stop with a dirty worktree. Do not discard intended changes. Reconcile the source-of-truth repo state, commit/push/merge or report exactly what remains, verify remote state, then stop with a clean worktree. If blocked, report git status --short and the exact blocker.'
    ;;
  push_to_main)
    guidance='This push_to_main task must not stop with a dirty worktree. Do not discard intended changes. Stage and commit intended work, push to the default branch or report the exact blocker, then stop with a clean worktree. If blocked, report git status --short and the exact blocker.'
    ;;
  *)
    guidance='Do not discard intended changes. Resolve the dirty worktree according to the delivery contract, or report git status --short and the exact blocker before stopping.'
    ;;
esac

printf '{"decision":"block","reason":"Fleet stop hook: worktree has %s uncommitted file(s). %s Nudge %s/%s."}\\n' "$dirty_files" "$guidance" "$next_attempt" "$max_nudges"
`;
}
