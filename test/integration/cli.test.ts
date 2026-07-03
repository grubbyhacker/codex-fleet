import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("cli views", () => {
  it("lists and reads tasks across clients through daemon rpc", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-cli-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    createClient(paths, "cli", "cli");
    const orchestrator = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "cli fixture"
      })) as { taskId: string };

      const listed = await runCli(root, "list");
      expect(listed).toContain(delegated.taskId);

      const status = await runCli(root, "status", delegated.taskId);
      expect(status).toContain("exited");

      const logs = await runCli(root, "logs", delegated.taskId);
      expect(logs).toContain("task_created");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("lists and runs cleanup candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-cli-cleanup-"));
    const repo = join(root, "base-repo");
    initRepo(repo);
    const paths = resolveFleetPaths(join(root, "fleet"));
    mkdirSync(paths.rootDir, { recursive: true });
    writeFileSync(
      paths.reposPath,
      `${JSON.stringify({
        repos: [{ alias: "fixture", baseCheckout: repo, defaultBranch: "main" }]
      })}\n`
    );
    const daemon = await startDaemon(paths);
    createClient(paths, "cli", "cli");
    const orchestrator = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: orchestrator.token };

    try {
      const clean = await delegatePatch(rpc);
      const cleanTask = await getTask(rpc, clean.taskId);
      const dryRun = await runCli(paths.rootDir, "cleanup", "list", "--dry-run");
      expect(dryRun).toContain(clean.taskId);
      expect(dryRun).toContain("cleanup_ready");

      const runDryRun = await runCli(
        paths.rootDir,
        "cleanup",
        "run",
        "--task",
        clean.taskId,
        "--dry-run"
      );
      expect(runDryRun).toContain('"dryRun": true');
      expect(runDryRun).toContain("cleanup_ready");
      expect(existsSync(cleanTask.worktreePath ?? "")).toBe(true);

      await runCli(paths.rootDir, "cleanup", "run", "--task", clean.taskId.slice(0, 8));
      expect(existsSync(cleanTask.worktreePath ?? "")).toBe(false);

      const dirty = await delegatePatch(rpc);
      const dirtyTask = await getTask(rpc, dirty.taskId);
      writeFileSync(join(dirtyTask.worktreePath ?? "", "dirty.txt"), "dirty\n");
      const dirtyDryRun = await runCli(paths.rootDir, "cleanup", "list", "--dry-run");
      expect(dirtyDryRun).toContain(dirty.taskId);
      expect(dirtyDryRun).toContain("cleanup_blocked_dirty");

      await runCli(paths.rootDir, "cleanup", "run", "--task", dirty.taskId, "--force");
      expect(existsSync(dirtyTask.worktreePath ?? "")).toBe(false);
      expect(branchExists(repo, dirtyTask.branch ?? "")).toBe(false);

      const wipeClean = await delegatePatch(rpc);
      const wipeCleanTask = await getTask(rpc, wipeClean.taskId);
      const wipeDirty = await delegatePatch(rpc);
      const wipeDirtyTask = await getTask(rpc, wipeDirty.taskId);
      writeFileSync(join(wipeDirtyTask.worktreePath ?? "", "discard-me.txt"), "discard me\n");

      const wipeDryRun = await runCli(paths.rootDir, "cleanup", "wipe-clean", "--dry-run");
      expect(wipeDryRun).toContain(wipeClean.taskId);
      expect(wipeDryRun).toContain(wipeDirty.taskId);
      expect(wipeDryRun).toContain("cleanup_blocked_dirty");
      expect(existsSync(wipeCleanTask.worktreePath ?? "")).toBe(true);
      expect(existsSync(wipeDirtyTask.worktreePath ?? "")).toBe(true);

      const wipeResult = await runCli(paths.rootDir, "cleanup", "wipe-clean");
      expect(wipeResult).toContain('"dryRun": false');
      expect(wipeResult).toContain(wipeClean.taskId);
      expect(wipeResult).toContain(wipeDirty.taskId);
      expect(existsSync(wipeCleanTask.worktreePath ?? "")).toBe(false);
      expect(existsSync(wipeDirtyTask.worktreePath ?? "")).toBe(false);
      expect(branchExists(repo, wipeCleanTask.branch ?? "")).toBe(false);
      expect(branchExists(repo, wipeDirtyTask.branch ?? "")).toBe(false);
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("prints a macOS LaunchAgent plist", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-cli-service-"));
    const previousModel = process.env.CODEX_FLEET_CODEX_MODEL;
    delete process.env.CODEX_FLEET_CODEX_MODEL;
    try {
      const plist = await runCli(root, "service", "launch-agent", "print");
      expect(plist).toContain("dev.codex-fleet.daemon");
      expect(plist).toContain(".local/bin/codex-fleet-daemon");
      expect(plist).toContain("<string>run</string>");
      expect(plist).not.toContain("<string>bun</string>");
      expect(plist).not.toContain("packages/cli/src/index.ts");
      expect(plist).toContain("<key>PATH</key>");
      expect(plist).toContain("/opt/homebrew/bin");
      expect(plist).toContain("CODEX_FLEET_STATE_DIR");
      expect(plist).toContain("CODEX_FLEET_WORKER_BACKEND");
      expect(plist).toContain("CODEX_FLEET_CODEX_COMMAND");
      expect(plist).not.toContain("CODEX_FLEET_CODEX_MODEL");
      expect(plist).not.toContain("gpt-5.3-codex-spark");
      expect(plist).toContain(root);
    } finally {
      restoreEnv("CODEX_FLEET_CODEX_MODEL", previousModel);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function runCli(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, "run", "packages/cli/src/index.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...stringEnv(process.env),
      CODEX_FLEET_STATE_DIR: root,
      CODEX_FLEET_CLIENT_ID: "cli"
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
    throw new Error(`CLI exited ${exitCode}: ${stderr}`);
  }
  return stdout;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function delegatePatch(rpc: { socketPath: string; clientId: string; token: string }) {
  return (await callDaemon(rpc, "delegate_task", {
    target: { repo: "fixture" },
    deliveryMode: "patch",
    prompt: "patch"
  })) as { taskId: string };
}

async function getTask(
  rpc: { socketPath: string; clientId: string; token: string },
  taskId: string
) {
  const result = (await callDaemon(rpc, "get_task", { taskId })) as {
    task: { branch?: string; worktreePath?: string };
  };
  return result.task;
}

function branchExists(repo: string, branch: string): boolean {
  if (!branch) {
    return false;
  }
  return execFileSync("git", ["branch", "--list", branch], {
    cwd: repo,
    encoding: "utf8"
  }).includes(branch);
}

function initRepo(path: string): void {
  execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: path, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Codex Fleet Test",
      "-c",
      "user.email=fleet@example.test",
      "commit",
      "-m",
      "init"
    ],
    { cwd: path, stdio: "ignore" }
  );
}
