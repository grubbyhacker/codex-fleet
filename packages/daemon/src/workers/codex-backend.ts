import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { WorkerBackend, WorkerInput, WorkerResult } from "./backend.js";

type CodexToolResult = {
  threadId?: string;
  content?: string;
};

export class CodexWorkerBackend implements WorkerBackend {
  async run(input: WorkerInput): Promise<WorkerResult> {
    const cwd = input.worktreePath ?? process.cwd();
    const transport = new StdioClientTransport({
      command: process.env.CODEX_FLEET_CODEX_COMMAND ?? "codex",
      args: ["mcp-server"],
      cwd,
      stderr: "pipe"
    });
    const client = new Client({ name: `codex-fleet-worker-${input.taskId}`, version: "0.0.0" });

    try {
      await client.connect(transport, { timeout: 30_000 });
      const result = await client.callTool(
        {
          name: "codex",
          arguments: stripUndefined({
            prompt: input.request.prompt,
            cwd,
            model: process.env.CODEX_FLEET_CODEX_MODEL ?? process.env.CODEX_FLEET_E2E_MODEL,
            sandbox:
              input.request.deliveryMode === "research_only" ? "read-only" : "danger-full-access",
            "approval-policy": "never",
            "developer-instructions": workerInstructions(input)
          })
        },
        undefined,
        { timeout: Number(process.env.CODEX_FLEET_CODEX_TIMEOUT_MS ?? "600000") }
      );
      const parsed = parseCodexResult(result);
      return {
        exitCode: 0,
        finalResponsePreview: preview(parsed.content ?? "")
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

export function workerBackendFromEnv(): WorkerBackend {
  return process.env.CODEX_FLEET_WORKER_BACKEND === "codex"
    ? new CodexWorkerBackend()
    : new FakeWorkerBackend();
}

import { FakeWorkerBackend } from "./backend.js";

function workerInstructions(input: WorkerInput): string {
  const worktree = input.worktreePath
    ? `You're in a fresh git worktree at ${input.worktreePath}. Before working, make the environment ready per AGENTS.md; if a tool reports "not trusted," trust it for this path.`
    : "You are running as a Codex Fleet shell worker with host access and no repo worktree.";
  return [
    "You are a task-scoped worker agent in a local Codex Fleet.",
    `Task id: ${input.taskId}`,
    input.branch ? `Branch: ${input.branch}` : undefined,
    worktree,
    "Keep responses concise and report concrete paths and commands."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
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

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function preview(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
