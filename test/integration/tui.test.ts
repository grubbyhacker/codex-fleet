import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TaskSnapshot } from "../../packages/shared/src/index.js";
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
      expect(rendered).toContain(`diff: git -C '${worktreePath}' status --short`);
      expect(rendered).toContain("release: codex-fleet cleanup run --task repo-wor");
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
}): TaskSnapshot {
  return {
    createdAt: overrides.createdAt,
    deliveryMode: "research_only",
    exitCode: overrides.state === "exited" ? 0 : undefined,
    id: overrides.id,
    lastActivityAt: overrides.lastActivityAt,
    ownerSession: { clientId: "orch" },
    risk: "low",
    state: overrides.state,
    target: { repo: "youknowme" },
    updatedAt: overrides.updatedAt,
    worktreePath: overrides.worktreePath
  };
}
