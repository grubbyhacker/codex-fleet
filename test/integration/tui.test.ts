import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Event, TaskSnapshot } from "../../packages/shared/src/index.js";
import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";
import { renderDashboard } from "../../packages/tui/src/index.js";

describe("tui dashboard", () => {
  it("renders fleet-wide read-only task data for a dashboard client", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-tui-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const orchestrator = createClient(paths, "orch", "orchestrator");
    createClient(paths, "dashboard", "dashboard");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      await callDaemon(rpc, "initialize", { sessionName: "tui-session" });
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "show in dashboard"
      })) as { taskId: string };

      const output = await runTui(root, "--once", "--json", "--task", delegated.taskId);
      expect(output.rendered).toContain("Codex Fleet");
      expect(output.rendered).toContain("orch/tui-session");
      expect(output.rendered).toContain(delegated.taskId);
      expect(output.tasks).toContainEqual(expect.objectContaining({ id: delegated.taskId }));
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("puts live work first and hides old terminal and stale noise by default", () => {
    const now = "2026-06-18T18:00:00.000Z";
    const rendered = renderDashboard(
      {
        collectedAt: now,
        histories: {},
        tasks: [
          task({
            id: "old-terminal-task",
            state: "exited",
            createdAt: "2026-06-18T10:00:00.000Z",
            updatedAt: "2026-06-18T10:02:00.000Z"
          }),
          task({
            id: "active-task-id",
            state: "running",
            createdAt: "2026-06-18T17:55:00.000Z",
            updatedAt: "2026-06-18T17:55:00.000Z",
            lastActivityAt: "2026-06-18T17:55:00.000Z"
          }),
          task({
            id: "old-stale-task",
            state: "stale",
            createdAt: "2026-06-18T09:55:00.000Z",
            updatedAt: "2026-06-18T10:00:00.000Z",
            lastActivityAt: "2026-06-18T09:55:00.000Z"
          }),
          task({
            id: "fresh-terminal-task",
            state: "exited",
            createdAt: "2026-06-18T17:50:00.000Z",
            updatedAt: "2026-06-18T17:59:00.000Z"
          })
        ]
      },
      { color: false }
    );

    expect(rendered).toContain("LIVE 1");
    expect(rendered).toContain("stale 1");
    expect(rendered).toContain("hidden-old 2");
    expect(rendered).toContain("2 older tasks hidden");
    expect(rendered).toContain("active-task-id");
    expect(rendered).toContain("fresh-te");
    expect(rendered).not.toContain("old-terminal-task");
    expect(rendered).not.toContain("old-stale-task");
    expect(rendered.indexOf("active-t")).toBeLessThan(rendered.indexOf("fresh-te"));
  });

  it("shows fresh stale work outside the live section", () => {
    const rendered = renderDashboard(
      {
        collectedAt: "2026-06-18T18:00:00.000Z",
        histories: {},
        tasks: [
          task({
            id: "fresh-stale-task",
            state: "stale",
            createdAt: "2026-06-18T17:45:00.000Z",
            updatedAt: "2026-06-18T17:55:00.000Z",
            lastActivityAt: "2026-06-18T17:45:00.000Z"
          })
        ]
      },
      { color: false }
    );

    expect(rendered).toContain("LIVE 0");
    expect(rendered).toContain("stale 1");
    expect(rendered).toContain("Stale");
    expect(rendered).toContain("fresh-s");
    expect(rendered).toContain("quiet 15m ago");
  });

  it("uses selected task details with a full-width bottom event pane", () => {
    const selected = task({
      id: "selected-task-id",
      state: "exited",
      createdAt: "2026-06-18T17:45:00.000Z",
      updatedAt: "2026-06-18T17:55:00.000Z",
      prompt: "Explain the selected task prompt in detail.",
      finalResponse: "The full answer is visible in the activity pane.",
      workerStderr: "stderr diagnostic line"
    });
    const rendered = renderDashboard(
      {
        collectedAt: "2026-06-18T18:00:00.000Z",
        histories: {
          [selected.id]: [
            event(selected.id, 1, "task_created", '{"promptPreview":"do work"}'),
            event(
              selected.id,
              2,
              "task_activity",
              '{"kind":"codex_event","detail":"item_completed"}'
            ),
            event(selected.id, 3, "task_state", '{"state":"exited","exitCode":0}')
          ]
        },
        tasks: [selected]
      },
      { color: false, width: 120 }
    );

    expect(rendered).toContain("╭ Tasks");
    expect(rendered).toContain("╭ Selected");
    expect(rendered).toContain("╭ Events");
    expect(rendered).toContain("CODEX FLEET");
    expect(rendered).toContain(">  selected");
    expect(rendered).toContain("Selected Task");
    expect(rendered).toContain(`Started:  ${formatExpectedLocalTimestamp(selected.createdAt)}`);
    expect(rendered).toContain(`Updated:  ${formatExpectedLocalTimestamp(selected.updatedAt)}`);
    expect(rendered).toContain(
      `updated ${formatExpectedLocalTimestamp("2026-06-18T18:00:00.000Z")}`
    );
    expect(rendered).not.toContain("2026-06-18T18:00:00.000Z");
    expect(rendered).toContain("Prompt");
    expect(rendered).toContain("Explain the selected task prompt");
    expect(rendered).toContain("Final Response");
    expect(rendered).toContain("The full answer is visible");
    expect(rendered).toContain("Worker Stderr");
    expect(rendered).toContain("stderr diagnostic line");
    expect(rendered).toContain("task_activity");
    expect(rendered.indexOf("╭ Events")).toBeGreaterThan(rendered.indexOf("╭ Selected"));
  });

  it("keeps the selected row readable in color mode", () => {
    const rendered = renderDashboard(
      {
        collectedAt: "2026-06-18T18:00:00.000Z",
        histories: {},
        tasks: [
          task({
            id: "selected-readable-task",
            state: "running",
            createdAt: "2026-06-18T17:55:00.000Z",
            updatedAt: "2026-06-18T17:55:00.000Z",
            lastActivityAt: "2026-06-18T17:55:00.000Z"
          })
        ]
      },
      { color: true, width: 120 }
    );

    expect(rendered).toContain("\u001b[1;33m>  selected");
    expect(rendered).not.toContain("\u001b[7;");
  });

  it("renders demo fleet data with multiple active sessions and a persistent logo", async () => {
    const output = await runTui(
      "",
      "--once",
      "--json",
      "--demo",
      "--no-color",
      "--task",
      "demo-prod"
    );

    expect(output.rendered).toContain("Codex Fleet");
    expect(output.rendered).toContain("CODEX FLEET");
    expect(output.rendered).toContain("Codex tokens: today 245k | week 1.9M | month 5.7M");
    expect(output.rendered).toContain("FOCUS: TASKS");
    expect(output.rendered).toContain("NAV: h/l/e focus");
    expect(output.rendered).toContain("VIEW: o overview");
    expect(output.rendered).toContain("OPS: x wipe clean action queue");
    expect(output.rendered).toContain("LIVE 3");
    expect(output.rendered).toContain("orch/ui-polish");
    expect(output.rendered).toContain("orch/prod-diagnostics");
    expect(output.rendered).toContain("orch/model-routing");
    expect(output.rendered).toContain(">  demo-pro");
    expect(output.tasks).toHaveLength(4);
  });

  it("can focus the selected pane on the retained prompt", () => {
    const selected = task({
      id: "prompt-task-id",
      state: "running",
      createdAt: "2026-06-18T17:45:00.000Z",
      updatedAt: "2026-06-18T17:55:00.000Z",
      lastActivityAt: "2026-06-18T17:55:00.000Z",
      prompt: "Investigate the dashboard and report the exact worker prompt."
    });
    const rendered = renderDashboard(
      {
        collectedAt: "2026-06-18T18:00:00.000Z",
        histories: {},
        tasks: [selected]
      },
      { color: false, mode: "prompt", width: 120 }
    );

    expect(rendered).toContain("mode prompt");
    expect(rendered).toContain("Prompt");
    expect(rendered).toContain("Investigate the dashboard");
    expect(rendered).not.toContain("No final response yet");
  });

  it("promotes terminal tasks with retained worktrees as attention items", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "codex-fleet-tui-worktree-"));
    try {
      const rendered = renderDashboard(
        {
          collectedAt: "2026-06-18T18:00:00.000Z",
          histories: {},
          tasks: [
            task({
              id: "repo-worktree-task",
              state: "exited",
              createdAt: "2026-06-18T17:55:00.000Z",
              updatedAt: "2026-06-18T17:56:00.000Z",
              worktreePath
            }),
            task({
              id: "old-terminal-task",
              state: "exited",
              createdAt: "2026-06-18T10:00:00.000Z",
              updatedAt: "2026-06-18T10:01:00.000Z"
            })
          ]
        },
        { color: false }
      );

      expect(rendered).toContain("attention 1");
      expect(rendered).toContain("Action Queue");
      expect(rendered).toContain("repo-wor");
      expect(rendered).toContain("needs worktree");
      expect(rendered).toContain("inspect: codex-fleet status repo-wor");
      expect(rendered).toContain("diff: git -C");
      expect(rendered).toContain("release: codex-fleet cleanup run --task repo-wor");
      expect(rendered).toContain("wipe all disposable worktrees: press x");
      expect(rendered).toContain("1 older task hidden");
    } finally {
      rmSync(worktreePath, { force: true, recursive: true });
    }
  });

  it("does not promote terminal tasks when retained worktrees are already removed", () => {
    const rendered = renderDashboard(
      {
        collectedAt: "2026-06-18T18:00:00.000Z",
        histories: {},
        tasks: [
          task({
            id: "removed-worktree-task",
            state: "exited",
            createdAt: "2026-06-18T10:00:00.000Z",
            updatedAt: "2026-06-18T10:01:00.000Z",
            worktreePath: "/tmp/codex-fleet-missing-worktree"
          })
        ]
      },
      { color: false }
    );

    expect(rendered).toContain("attention 0");
    expect(rendered).not.toContain("Action Queue");
    expect(rendered).toContain("1 older task hidden");
  });

  it("does not promote terminal failures without retained worktrees as attention items", () => {
    const rendered = renderDashboard(
      {
        collectedAt: "2026-06-18T18:00:00.000Z",
        histories: {},
        tasks: [
          task({
            id: "failed-shell-task",
            state: "failed_to_start",
            createdAt: "2026-06-18T17:55:00.000Z",
            updatedAt: "2026-06-18T17:56:00.000Z"
          })
        ]
      },
      { color: false }
    );

    expect(rendered).toContain("attention 0");
    expect(rendered).not.toContain("Action Queue");
    expect(rendered).toContain("[FAILED_TO_START]");
    expect(rendered).toContain("failed_to_start");
  });
});

async function runTui(
  root: string,
  ...args: string[]
): Promise<{
  rendered: string;
  tasks: Array<{ id: string }>;
}> {
  const proc = Bun.spawn([process.execPath, "run", "packages/tui/src/index.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...stringEnv(process.env),
      CODEX_FLEET_STATE_DIR: root,
      CODEX_FLEET_CLIENT_ID: "dashboard"
    },
    stderr: "pipe",
    stdout: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`TUI exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as { rendered: string; tasks: Array<{ id: string }> };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function task(overrides: {
  id: string;
  state: "exited" | "failed_to_start" | "running" | "stale";
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  worktreePath?: string;
  prompt?: string;
  finalResponse?: string;
  workerStderr?: string;
}): TaskSnapshot {
  return {
    createdAt: overrides.createdAt,
    deliveryMode: "research_only",
    exitCode: overrides.state === "exited" ? 0 : undefined,
    finalResponse: overrides.finalResponse,
    finalResponsePreview: overrides.finalResponse,
    id: overrides.id,
    lastActivityAt: overrides.lastActivityAt,
    ownerSession: { clientId: "orch" },
    prompt: overrides.prompt,
    promptPreview: overrides.prompt,
    risk: "low",
    state: overrides.state,
    target: { repo: "youknowme" },
    updatedAt: overrides.updatedAt,
    workerStderr: overrides.workerStderr,
    workerStderrPreview: overrides.workerStderr,
    worktreePath: overrides.worktreePath
  };
}

function event(taskId: string, seq: number, type: string, summary: string): Event {
  return {
    seq,
    summary,
    taskId,
    ts: "2026-06-18T18:00:00.000Z",
    type
  };
}

function formatExpectedLocalTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    second: "2-digit",
    timeZoneName: "short",
    year: "numeric"
  }).format(new Date(value));
}
