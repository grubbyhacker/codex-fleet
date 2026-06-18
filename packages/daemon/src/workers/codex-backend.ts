import { existsSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { WorkerBackend, WorkerInput, WorkerResult } from "./backend.js";

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

    try {
      await client.connect(transport, { timeout: 30_000 });
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
      return codexWorkerResultFromToolResult(result);
    } finally {
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
      : "You are running as a Codex Fleet shell worker with host access and no repo worktree.";
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

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function preview(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
