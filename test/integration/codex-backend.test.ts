import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  codexWorkerResultFromToolResult,
  codexWorkerToolArguments,
  resolveCodexCommand
} from "../../packages/daemon/src/workers/codex-backend.js";

describe("codex worker backend", () => {
  it("honors explicit codex command configuration", () => {
    const previous = process.env.CODEX_FLEET_CODEX_COMMAND;
    process.env.CODEX_FLEET_CODEX_COMMAND = "/custom/codex";
    try {
      expect(resolveCodexCommand(["/missing/codex"])).toBe("/custom/codex");
    } finally {
      restoreEnv("CODEX_FLEET_CODEX_COMMAND", previous);
    }
  });

  it("uses the first existing installed command candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-codex-command-"));
    try {
      const candidate = join(root, "Codex.app", "Contents", "Resources", "codex");
      mkdirSync(join(root, "Codex.app", "Contents", "Resources"), { recursive: true });
      writeFileSync(candidate, "#!/bin/sh\n");
      expect(resolveCodexCommand(["/missing/codex", candidate])).toBe(candidate);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("falls back to PATH lookup when no candidate exists", () => {
    const previous = process.env.CODEX_FLEET_CODEX_COMMAND;
    delete process.env.CODEX_FLEET_CODEX_COMMAND;
    try {
      expect(resolveCodexCommand(["/missing/codex"])).toBe("codex");
    } finally {
      restoreEnv("CODEX_FLEET_CODEX_COMMAND", previous);
    }
  });

  it("launches research workers with yolo permissions", () => {
    const args = codexWorkerToolArguments(
      {
        taskId: "task-1",
        request: {
          target: { shell: true },
          deliveryMode: "research_only",
          risk: "standard",
          prompt: "Inspect gh availability"
        }
      },
      "/tmp/codex-fleet-worker"
    );

    expect(args).toMatchObject({
      prompt: "Inspect gh availability",
      cwd: "/tmp/codex-fleet-worker",
      sandbox: "danger-full-access",
      "approval-policy": "never"
    });
  });

  it("tells review workers to commit, push, and open a PR", () => {
    const args = codexWorkerToolArguments(
      {
        taskId: "task-2",
        branch: "fleet/fixture/task-2",
        worktreePath: "/tmp/codex-fleet-worker",
        request: {
          target: { repo: "fixture" },
          deliveryMode: "pr_for_review",
          risk: "standard",
          prompt: "Implement a docs update"
        }
      },
      "/tmp/codex-fleet-worker"
    );

    expect(args["developer-instructions"]).toContain(
      "stage only intended changes, commit them on the task branch, push the branch, open a PR"
    );
    expect(args["developer-instructions"]).toContain(
      "Do not leave intended review changes only as untracked or uncommitted files"
    );
  });

  it("marks codex backend error payloads as failed worker results", () => {
    const content = JSON.stringify(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Tool 'image_generation' is not supported with this model.",
          param: "tools"
        },
        status: 400
      },
      null,
      2
    );

    const result = codexWorkerResultFromToolResult({
      structuredContent: {
        threadId: "thread-1",
        content
      }
    });

    expect(result).toMatchObject({
      exitCode: 1,
      codexThreadId: "thread-1",
      finalResponse: content,
      finalResponsePreview: content
    });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
