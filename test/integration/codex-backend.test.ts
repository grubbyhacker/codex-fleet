import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  captureTextStream,
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

  it("warns shell workers away from mutating shared repo checkouts", () => {
    const args = codexWorkerToolArguments(
      {
        taskId: "task-shell",
        shellPath: "/tmp/codex-fleet-shell/task-shell",
        request: {
          target: { shell: true },
          deliveryMode: "full_delivery",
          risk: "standard",
          prompt: "Deploy the current service"
        }
      },
      "/tmp/codex-fleet-shell/task-shell"
    );

    expect(args["cwd"]).toBe("/tmp/codex-fleet-shell/task-shell");
    expect(args["developer-instructions"]).toContain("no isolated repo worktree");
    expect(args["developer-instructions"]).toContain("/tmp/codex-fleet-shell/task-shell");
    expect(args["developer-instructions"]).toContain("Treat local shared checkouts as read-only");
    expect(args["developer-instructions"]).toContain("do not mutate shared repo checkouts");
    expect(args["developer-instructions"]).toContain("repo target is required");
    expect(args["developer-instructions"]).not.toContain("commit, push, open a PR");
  });

  it("refuses push-to-main semantics for shell workers", () => {
    const args = codexWorkerToolArguments(
      {
        taskId: "task-shell-main",
        request: {
          target: { shell: true },
          deliveryMode: "push_to_main",
          risk: "standard",
          prompt: "Commit and push directly"
        }
      },
      "/Users/roger/src/agent-infra/vps-ops"
    );

    expect(args["developer-instructions"]).toContain("Delivery mode push_to_main on shell");
    expect(args["developer-instructions"]).toContain("Do not commit or push from shell");
    expect(args["developer-instructions"]).toContain("isolated worktree");
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

  it("warns workers to avoid whole-file rewrites for large artifacts", () => {
    const args = codexWorkerToolArguments(
      {
        taskId: "task-large-artifact",
        branch: "fleet/fixture/task-large-artifact",
        worktreePath: "/tmp/codex-fleet-worker",
        request: {
          target: { repo: "fixture" },
          deliveryMode: "full_delivery",
          risk: "standard",
          prompt: "Update a large dashboard JSON file"
        }
      },
      "/tmp/codex-fleet-worker"
    );

    expect(args["developer-instructions"]).toContain("Large artifact/context guardrail");
    expect(args["developer-instructions"]).toContain("avoid loading or emitting whole files");
    expect(args["developer-instructions"]).toContain("Use structured tools such as jq");
    expect(args["developer-instructions"]).toContain("split into smaller tasks");
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

  it("marks codex missing-session text as a failed worker result", () => {
    const content = "Session not found for thread_id: 019ef6fa-8c18-7ad3-9ce7-2932e2d33132";

    const result = codexWorkerResultFromToolResult({
      structuredContent: {
        threadId: "019ef6fa-8c18-7ad3-9ce7-2932e2d33132",
        content
      }
    });

    expect(result).toMatchObject({
      exitCode: 1,
      codexThreadId: "019ef6fa-8c18-7ad3-9ce7-2932e2d33132",
      finalResponse: content,
      finalResponsePreview: content
    });
  });

  it("captures bounded worker stderr text", () => {
    const stream = new PassThrough();
    const capture = captureTextStream(stream, 12);

    stream.write("first line\n");
    stream.write("second line\n");
    capture.dispose();
    stream.write("ignored\n");

    expect(capture.read()).toBe("second line\n");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
