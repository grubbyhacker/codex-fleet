import { existsSync } from "node:fs";
import type { Stream } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  WorkerRunError,
  type WorkerBackend,
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
    const cwd = input.worktreePath ?? input.repoBaseCheckout ?? process.cwd();
    const transport = new StdioClientTransport({
      command: resolveCodexCommand(),
      args: ["mcp-server"],
      cwd,
      stderr: "pipe"
    });
    const client = new Client({ name: `codex-fleet-worker-${input.taskId}`, version: "0.0.0" });
    const stderrCapture = captureTextStream(transport.stderr);
    const heartbeat = setInterval(
      () => {
        input.onActivity?.({ kind: "heartbeat" });
      },
      Number(process.env.CODEX_FLEET_WORKER_HEARTBEAT_MS ?? "30000")
    );
    heartbeat.unref?.();

    try {
      client.setNotificationHandler(CodexEventNotificationSchema, (notification) => {
        input.onActivity?.({ kind: "codex_event", detail: codexEventDetail(notification) });
      });
      await client.connect(transport, { timeout: 30_000 });
      input.onActivity?.({ kind: "heartbeat", detail: "connected" });
      const result = await client.callTool(
        input.codexThreadId
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
            },
        undefined,
        { timeout: Number(process.env.CODEX_FLEET_CODEX_TIMEOUT_MS ?? "600000") }
      );
      return withWorkerStderr(codexWorkerResultFromToolResult(result), stderrCapture.read());
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
      : "You are running as a Codex Fleet shell worker with host access and no isolated repo worktree. Treat local shared checkouts as read-only: do not run git checkout/switch/add/commit/push there and do not edit files in those repos. If the task requires repo mutation, report that it should be delegated to a repo target so Fleet can create an isolated worktree.";
  return [
    "You are a task-scoped worker agent in a local Codex Fleet.",
    `Task id: ${input.taskId}`,
    input.branch ? `Branch: ${input.branch}` : undefined,
    workspace,
    deliveryModeInstructions(input),
    "Keep responses concise and report concrete paths and commands."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function deliveryModeInstructions(input: WorkerInput): string {
  if ("shell" in input.request.target) {
    return shellDeliveryModeInstructions(input);
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

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Request timed out") || message.includes("-32001");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function preview(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
