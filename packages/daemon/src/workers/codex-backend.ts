import { existsSync } from "node:fs";
import type { Stream } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  WorkerRunError,
  type WorkerBackend,
  type WorkerActivityTelemetry,
  type WorkerInput,
  type WorkerResult
} from "./backend.js";

type CodexToolResult = {
  threadId?: string;
  content?: string;
};

type CodexBackendError = {
  type?: string;
  error?: {
    type?: string;
    message?: string;
    param?: string;
  };
  status?: number;
};

const CodexEventNotificationSchema = NotificationSchema.extend({
  method: z.literal("codex/event")
}).loose();

export class CodexWorkerBackend implements WorkerBackend {
  async run(input: WorkerInput): Promise<WorkerResult> {
    const cwd = input.worktreePath ?? input.repoBaseCheckout ?? input.shellPath ?? process.cwd();
    const transport = new StdioClientTransport({
      command: resolveCodexCommand(),
      args: codexWorkerCommandArgs(input),
      cwd,
      stderr: "pipe"
    });
    const client = new Client({ name: `codex-fleet-worker-${input.taskId}`, version: "0.0.0" });
    const stderrCapture = captureTextStream(transport.stderr);
    const telemetry = new CodexEventTelemetry();
    const heartbeat = setInterval(
      () => {
        input.onActivity?.({ kind: "heartbeat" });
      },
      Number(process.env.CODEX_FLEET_WORKER_HEARTBEAT_MS ?? "30000")
    );
    heartbeat.unref?.();

    try {
      client.setNotificationHandler(CodexEventNotificationSchema, (notification) => {
        const activity = telemetry.activity(notification);
        input.onActivity?.({
          kind: "codex_event",
          detail: activity.eventType,
          telemetry: activity
        });
      });
      await client.connect(transport, { timeout: 30_000 });
      input.onActivity?.({ kind: "heartbeat", detail: "connected" });
      const result = await client.callTool(codexToolCall(input, cwd), undefined, {
        timeout: codexTimeoutMs()
      });
      let workerResult = codexWorkerResultFromToolResult(result);
      if (input.codexThreadId && isCodexSessionNotFound(workerResult.finalResponse)) {
        input.onActivity?.({
          kind: "codex_event",
          detail: "resume_thread_missing_retrying_fresh"
        });
        const retryResult = await client.callTool(
          {
            name: "codex",
            arguments: codexWorkerToolArguments(input, cwd)
          },
          undefined,
          { timeout: codexTimeoutMs() }
        );
        workerResult = codexWorkerResultFromToolResult(retryResult);
      }
      return withWorkerStderr(workerResult, stderrCapture.read());
    } catch (error) {
      const stderr = stderrCapture.read();
      throw new WorkerRunError(error instanceof Error ? error.message : String(error), {
        cause: error,
        terminalState: isTimeoutError(error) ? "timed_out" : "failed_to_start",
        workerStderr: stderr || undefined,
        workerStderrPreview: stderr ? preview(stderr) : undefined
      });
    } finally {
      clearInterval(heartbeat);
      stderrCapture.dispose();
      await client.close().catch(() => undefined);
    }
  }
}

export function codexWorkerResultFromToolResult(result: unknown): WorkerResult {
  const parsed = parseCodexResult(result);
  const finalResponse = parsed.content ?? "";
  return {
    exitCode: isCodexBackendError(finalResponse) ? 1 : 0,
    finalResponse,
    finalResponsePreview: preview(finalResponse),
    codexThreadId: parsed.threadId
  };
}

export function resolveCodexCommand(candidates = defaultCodexCommandCandidates()): string {
  const configured = process.env.CODEX_FLEET_CODEX_COMMAND;
  if (configured) {
    return configured;
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return "codex";
}

export function codexWorkerToolArguments(input: WorkerInput, cwd: string): Record<string, unknown> {
  return stripUndefined({
    prompt: input.request.prompt,
    cwd,
    model: process.env.CODEX_FLEET_CODEX_MODEL ?? process.env.CODEX_FLEET_E2E_MODEL,
    sandbox: "danger-full-access",
    "approval-policy": "never",
    "developer-instructions": workerInstructions(input)
  });
}

export function codexWorkerCommandArgs(input: WorkerInput): string[] {
  if (!input.stopHook) {
    return ["mcp-server"];
  }

  return [
    "--dangerously-bypass-hook-trust",
    "mcp-server",
    "-c",
    "features.hooks=true",
    "-c",
    stopHookConfigOverride(input.stopHook)
  ];
}

function codexToolCall(
  input: WorkerInput,
  cwd: string
): { name: "codex" | "codex-reply"; arguments: Record<string, unknown> } {
  return input.codexThreadId
    ? {
        name: "codex-reply",
        arguments: {
          prompt: input.request.prompt,
          threadId: input.codexThreadId
        }
      }
    : {
        name: "codex",
        arguments: codexWorkerToolArguments(input, cwd)
      };
}

function codexTimeoutMs(): number {
  return Number(process.env.CODEX_FLEET_CODEX_TIMEOUT_MS ?? "600000");
}

function defaultCodexCommandCandidates(): string[] {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    `${process.env.HOME ?? ""}/.local/bin/codex`
  ];
}

export function workerBackendFromEnv(): WorkerBackend {
  return process.env.CODEX_FLEET_WORKER_BACKEND === "codex"
    ? new CodexWorkerBackend()
    : new FakeWorkerBackend();
}

import { FakeWorkerBackend } from "./backend.js";

function workerInstructions(input: WorkerInput): string {
  const workspace = input.worktreePath
    ? `You're in a fresh git worktree at ${input.worktreePath}. Before working, make the environment ready per AGENTS.md; if a tool reports "not trusted," trust it for this path.`
    : input.repoBaseCheckout
      ? `You are doing read-only repo research in the registered base checkout at ${input.repoBaseCheckout}. Do not modify files, create branches, or change git state.`
      : `You are running as a Codex Fleet shell worker with host access and no isolated repo worktree. Your Fleet-owned scratch directory is ${input.shellPath ?? "the current working directory"}. Treat local shared checkouts as read-only: do not run git checkout/switch/add/commit/push there and do not edit files in those repos. If the task requires repo mutation, report that it should be delegated to a repo target so Fleet can create an isolated worktree.`;
  return [
    "You are a task-scoped worker agent in a local Codex Fleet.",
    `Task id: ${input.taskId}`,
    input.branch ? `Branch: ${input.branch}` : undefined,
    workspace,
    largeArtifactInstructions(),
    "shell" in input.request.target ? boundedShellDiagnosticsInstructions() : undefined,
    "repo" in input.request.target ? externalCheckWaitingInstructions() : undefined,
    "repo" in input.request.target ? mergePolicyInstructions(input) : undefined,
    deliveryModeInstructions(input),
    "Keep responses concise and report concrete paths and commands."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function largeArtifactInstructions(): string {
  return [
    "Large artifact/context guardrail: for generated dashboards, lockfiles, vendored data, snapshots, or other large files, avoid loading or emitting whole files when a targeted edit will work.",
    "Use structured tools such as jq, formatters, or small scripts to make narrow changes; inspect focused slices and verify with targeted checks.",
    "If the task requires both broad investigation and a large rewrite, do the smallest safe edit or stop and report that the work should be split into smaller tasks."
  ].join(" ");
}

function boundedShellDiagnosticsInstructions(): string {
  return [
    "Shell diagnostics guardrail: bound broad host inspections so the MCP call can return a useful report.",
    "For disk or filesystem investigations, prefer df, docker system summaries, known paths, and top-level du such as `du -xhd1`; avoid broad recursive scans over /, /var, Docker storage, or remote hosts.",
    "Use command-level timeouts where scans might hang or run long, and return partial findings plus the blocked command instead of waiting indefinitely."
  ].join(" ");
}

function externalCheckWaitingInstructions(): string {
  return [
    "External check waiting guardrail: after pushing a branch or opening/updating a PR, do not sit in a long polling loop waiting for GitHub Actions, CI, or other external checks unless the task explicitly requires you to wait for completion so you can merge or perform another requested delivery step.",
    "For review handoff, take one check snapshot, report pending/running/failing/passing checks with URLs or run ids when available, and exit.",
    "When explicit delivery authority requires waiting, keep the waiting inside this worker bounded and quiet: poll at a reasonable interval, continue only on material status changes or timeout, and report the final check outcome."
  ].join(" ");
}

function mergePolicyInstructions(input: WorkerInput): string {
  switch (input.mergePolicy) {
    case "human_review":
      return "Repo merge policy human_review: do not merge your own PR, do not approve your own PR, and do not push directly to the default branch. For delivery modes that would otherwise merge, stop after pushing the branch, opening/updating a ready PR, and reporting a CI/check snapshot.";
    case "agent_merge_explicit":
      return "Repo merge policy agent_merge_explicit: do not merge unless this task prompt explicitly instructs you to merge this PR. If merge is not explicit, stop after a ready PR and CI/check snapshot.";
    case "agent_merge_allowed":
      return "Repo merge policy agent_merge_allowed: you may merge when the delivery mode, task prompt, repository rules, and checks all allow it.";
    default:
      return "Repo merge policy unspecified: do not assume merge authority. Prefer stopping after a ready PR and CI/check snapshot unless the prompt explicitly says to merge.";
  }
}

function deliveryModeInstructions(input: WorkerInput): string {
  if ("shell" in input.request.target) {
    return shellDeliveryModeInstructions(input);
  }
  if (input.mergePolicy === "human_review") {
    switch (input.request.deliveryMode) {
      case "full_delivery":
        return "Delivery mode full_delivery under human_review: implement, verify, commit, push, open or update a ready PR, take one CI/check snapshot, report the PR URL and checks, then stop before merge.";
      case "push_to_main":
        return "Delivery mode push_to_main conflicts with repo merge policy human_review. Do not push directly to the default branch; report that this repo requires a PR for human review.";
    }
  }
  if (
    input.mergePolicy === "agent_merge_explicit" &&
    input.request.deliveryMode === "full_delivery"
  ) {
    return "Delivery mode full_delivery under agent_merge_explicit: implement, verify, commit, push, and open or update a ready PR. Merge only if this task prompt explicitly instructs you to merge this PR; otherwise report PR URL/check snapshot and stop before merge.";
  }
  switch (input.request.deliveryMode) {
    case "research_only":
      return "Delivery mode research_only: return findings only. Do not modify files, create commits, push branches, or open PRs.";
    case "patch":
      return "Delivery mode patch: implement and verify locally, then hand back the diff/status. Do not push or open a PR.";
    case "pr_for_review":
      return "Delivery mode pr_for_review: implement, verify, stage only intended changes, commit them on the task branch, push the branch, open a PR, and stop before merge. Do not leave intended review changes only as untracked or uncommitted files; if blocked, report the exact git status and blocker.";
    case "full_delivery":
      return "Delivery mode full_delivery: implement, verify, commit, push, open a PR if repo norms require it, and carry through merge only when the prompt and repo norms allow.";
    case "push_to_main":
      return "Delivery mode push_to_main: implement, verify, commit, and push directly to the repo default branch when that is the requested repo norm.";
  }
}

function shellDeliveryModeInstructions(input: WorkerInput): string {
  switch (input.request.deliveryMode) {
    case "research_only":
      return "Delivery mode research_only on shell: return findings only. Shell targets are for read-only checks, deploy observation, and host diagnostics; do not modify shared repo checkouts or git state.";
    case "patch":
      return "Delivery mode patch on shell: do not patch shared repo checkouts. If a code change is required, stop and report that the work should be rerun as a repo target. Host-local non-repo changes are allowed only when explicitly requested.";
    case "pr_for_review":
      return "Delivery mode pr_for_review on shell: shell has no isolated worktree, so do not stage, commit, push, or open a PR from a shared checkout. Report that repo changes must be delegated to a repo target.";
    case "full_delivery":
      return "Delivery mode full_delivery on shell: carry out explicitly requested host ops or deploy steps, but do not mutate shared repo checkouts or perform git commits/pushes. If source changes are needed, report that a repo target is required.";
    case "push_to_main":
      return "Delivery mode push_to_main on shell: refused for shared checkouts. Do not commit or push from shell; report that direct repo mutation must use a repo target with an isolated worktree.";
  }
}

function parseCodexResult(result: unknown): CodexToolResult {
  const maybeStructured = result as {
    structuredContent?: CodexToolResult;
    content?: Array<{ type: string; text?: string }>;
  };
  if (maybeStructured.structuredContent?.threadId || maybeStructured.structuredContent?.content) {
    return maybeStructured.structuredContent;
  }

  const text = maybeStructured.content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");

  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as CodexToolResult;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return { content: text };
  }

  return { content: text };
}

function isCodexBackendError(content: string): boolean {
  if (!content.trim()) {
    return false;
  }
  if (isCodexSessionNotFound(content)) {
    return true;
  }

  try {
    const parsed = JSON.parse(content) as CodexBackendError;
    return (
      parsed?.type === "error" &&
      typeof parsed.error === "object" &&
      typeof parsed.error?.message === "string" &&
      typeof parsed.status === "number" &&
      Number.isInteger(parsed.status) &&
      parsed.status >= 400
    );
  } catch {
    return false;
  }
}

function isCodexSessionNotFound(content: string): boolean {
  return /^Session not found for thread_id: \S+/i.test(content.trim());
}

function withWorkerStderr(result: WorkerResult, stderr: string): WorkerResult {
  if (!stderr) {
    return result;
  }
  return {
    ...result,
    workerStderr: stderr,
    workerStderrPreview: preview(stderr)
  };
}

export function captureTextStream(
  stream: Stream | null,
  maxLength = 64 * 1024
): { read: () => string; dispose: () => void } {
  let text = "";
  const onData = (chunk: string | Buffer): void => {
    text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.length > maxLength) {
      text = text.slice(text.length - maxLength);
    }
  };
  stream?.on("data", onData);
  return {
    read: () => text,
    dispose: () => stream?.off("data", onData)
  };
}

function codexEventDetail(notification: z.infer<typeof CodexEventNotificationSchema>): string {
  const params = notification.params as { msg?: { type?: unknown } } | undefined;
  return typeof params?.msg?.type === "string" ? params.msg.type : "event";
}

export class CodexEventTelemetry {
  private readonly active = new Map<string, { startedAt: number; eventType: string }>();
  private lastAnonymousStart: { startedAt: number; eventType: string } | undefined;

  activity(notification: z.infer<typeof CodexEventNotificationSchema>): WorkerActivityTelemetry {
    const message = codexEventMessage(notification);
    const eventType = codexEventDetail(notification);
    const callId = stringField(message, ["call_id", "callId", "id", "item_id", "itemId"]);
    const commandPreview = commandPreviewFrom(message);
    const toolName = toolNameFrom(message, eventType);
    const activity: WorkerActivityTelemetry = {
      eventType,
      toolName,
      callId,
      commandPreview,
      important: isToolBoundaryEvent(eventType)
    };

    const now = Date.now();
    if (isToolStartEvent(eventType)) {
      if (callId) {
        this.active.set(callId, { startedAt: now, eventType });
      } else {
        this.lastAnonymousStart = { startedAt: now, eventType };
      }
    }
    if (isToolEndEvent(eventType)) {
      const started = callId ? this.active.get(callId) : this.lastAnonymousStart;
      if (started) {
        activity.durationMs = Math.max(0, now - started.startedAt);
        if (callId) {
          this.active.delete(callId);
        } else {
          this.lastAnonymousStart = undefined;
        }
      }
      const exitCode = numberField(message, ["exit_code", "exitCode", "status"]);
      if (exitCode !== undefined) {
        activity.exitCode = exitCode;
      }
    }

    return stripUndefined(activity);
  }
}

function codexEventMessage(
  notification: z.infer<typeof CodexEventNotificationSchema>
): Record<string, unknown> | undefined {
  const params = notification.params as { msg?: unknown } | undefined;
  return isRecord(params?.msg) ? params.msg : undefined;
}

function isToolBoundaryEvent(eventType: string | undefined): boolean {
  return isToolStartEvent(eventType) || isToolEndEvent(eventType);
}

function isToolStartEvent(eventType: string | undefined): boolean {
  return Boolean(eventType && /(?:^|_)(begin|started|start)$/i.test(eventType));
}

function isToolEndEvent(eventType: string | undefined): boolean {
  return Boolean(eventType && /(?:^|_)(end|completed|complete|failed|errored)$/i.test(eventType));
}

function commandPreviewFrom(value: unknown): string | undefined {
  const raw = firstFieldDeep(value, ["command", "cmd", "argv", "args"]);
  if (Array.isArray(raw)) {
    return preview(redactSensitive(raw.map((item) => String(item)).join(" ")), 240);
  }
  if (typeof raw === "string") {
    return preview(redactSensitive(raw), 240);
  }
  return undefined;
}

function toolNameFrom(value: unknown, fallback: string | undefined): string | undefined {
  const raw = firstFieldDeep(value, ["tool", "tool_name", "toolName", "name"]);
  return typeof raw === "string" ? preview(raw, 80) : fallback;
}

function stringField(value: unknown, fields: string[]): string | undefined {
  const found = firstFieldDeep(value, fields);
  return typeof found === "string" ? preview(found, 120) : undefined;
}

function numberField(value: unknown, fields: string[]): number | undefined {
  const found = firstFieldDeep(value, fields);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

function firstFieldDeep(value: unknown, fields: string[], depth = 0): unknown {
  if (!isRecord(value) || depth > 4) {
    return undefined;
  }
  for (const field of fields) {
    if (field in value) {
      return value[field];
    }
  }
  for (const nested of Object.values(value)) {
    const found = firstFieldDeep(nested, fields, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSensitive(value: string): string {
  return value
    .replace(/(token|secret|password|passwd|api[_-]?key)=\S+/gi, "$1=<redacted>")
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1<redacted>")
    .replace(/(github_pat_|ghp_|sk-)[A-Za-z0-9_-]+/g, "$1<redacted>");
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Request timed out") || message.includes("-32001");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function stopHookConfigOverride(stopHook: NonNullable<WorkerInput["stopHook"]>): string {
  const fields = [
    'type="command"',
    `command=${tomlString(stopHook.command)}`,
    `timeout=${stopHook.timeoutSeconds}`,
    stopHook.statusMessage ? `statusMessage=${tomlString(stopHook.statusMessage)}` : undefined
  ]
    .filter((field): field is string => Boolean(field))
    .join(",");
  return `hooks.Stop=[{hooks=[{${fields}}]}]`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function preview(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
