# DCR-0005: Resume Fallback For Missing Codex Threads

Status: Accepted
Date: 2026-06-24

## Context

`docs/DESIGN.md` describes `resumeTaskId` as continuing the same task thread through Codex's reply mechanism. In practice, Codex can return `Session not found for thread_id: ...` for a thread id that Fleet previously captured from a completed task. The Fleet task, worktree, branch, and history still exist, but the backend conversation handle is no longer usable.

Before this change, Fleet recorded that plain-text Codex error as a successful worker result because it was not shaped like the structured JSON backend errors already handled.

## Decision

When a resume attempt receives Codex's missing-session response, retry once as a fresh Codex task in the same Fleet-owned cwd, worktree, and branch.

The resumed Fleet task id remains the same. The Codex thread id is replaced with the fresh thread id if the retry succeeds. Fleet logs a worker activity event with `resume_thread_missing_retrying_fresh` so the degradation is visible in history.

Codex missing-session text is also classified as a failed worker result if it reaches normal result handling.

## Consequences

- Follow-up work can continue in the same isolated worktree even when Codex has lost the old conversation.
- The fallback preserves filesystem and git continuity, but not model conversation context.
- Orchestrators no longer need to detect this backend-specific failure and start a separate task manually for simple continuation.
- If the fresh retry also fails, Fleet reports the failure instead of treating the missing-session text as success.
