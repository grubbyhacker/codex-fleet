import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

const runCodexE2e = process.env.CODEX_FLEET_RUN_CODEX_E2E === "1";
const describeCodex = runCodexE2e ? describe : describe.skip;

describeCodex("real codex e2e", () => {
  it("preflights the configured Codex model", async () => {
    const model = process.env.CODEX_FLEET_E2E_MODEL ?? "gpt-5.3-codex-spark";
    console.warn(`Running paid Codex E2E preflight with model ${model}`);
    const output = await runCodexPreflight(model);
    expect(output).toContain("codex-fleet-preflight-ok");
  }, 180_000);

  it("runs a minimal shell research task through the daemon", async () => {
    const model = process.env.CODEX_FLEET_E2E_MODEL ?? "gpt-5.3-codex-spark";
    console.warn(`Running paid Codex E2E with model ${model}`);

    const root = mkdtempSync(join(tmpdir(), "codex-fleet-e2e-"));
    const paths = resolveFleetPaths(root);
    const restoreEnv = useCodexBackend(model);

    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        modelTier: "cheap",
        prompt: "Reply with exactly: codex-fleet-e2e-ok"
      })) as { taskId: string };
      const task = await waitForExit(rpc, delegated.taskId);
      expect(task.task.state).toBe("exited");
      expect(task.task.finalResponsePreview).toContain("codex-fleet-e2e-ok");
    } finally {
      restoreEnv();
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  }, 180_000);

  it("patches a tiny repo in an isolated worktree without touching the base checkout", async () => {
    const model = process.env.CODEX_FLEET_E2E_MODEL ?? "gpt-5.3-codex-spark";
    console.warn(`Running paid Codex repo E2E with model ${model}`);

    const root = mkdtempSync(join(tmpdir(), "codex-fleet-e2e-repo-"));
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
    const restoreEnv = useCodexBackend(model);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "patch",
        modelTier: "cheap",
        prompt:
          "In this repo, replace README.md content with exactly '# codex-fleet-repo-e2e-ok\\n'. Do not edit any other file."
      })) as { taskId: string };
      const task = await waitForExit(rpc, delegated.taskId);
      expect(task.task.state).toBe("exited");
      expect(task.task.worktreePath).toBeTruthy();
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# fixture\n");
      expect(readFileSync(join(task.task.worktreePath ?? "", "README.md"), "utf8")).toBe(
        "# codex-fleet-repo-e2e-ok\n"
      );
    } finally {
      restoreEnv();
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  }, 180_000);

  it("nudges a dirty review worktree before allowing stop", async () => {
    const model = process.env.CODEX_FLEET_E2E_MODEL ?? "gpt-5.3-codex-spark";
    console.warn(`Running paid Codex stop-hook E2E with model ${model}`);

    const root = mkdtempSync(join(tmpdir(), "codex-fleet-e2e-stop-hook-"));
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
    const restoreEnv = useCodexBackend(model);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { repo: "fixture" },
        deliveryMode: "pr_for_review",
        modelTier: "cheap",
        prompt:
          "Reply exactly: codex-fleet-stop-hook-e2e-ok. Do not modify files, run git commands, commit, push, or open a PR."
      })) as { taskId: string };
      const started = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { worktreePath?: string };
      };
      writeFileSync(join(started.task.worktreePath ?? "", "DIRTY.txt"), "dirty\n");

      const task = await waitForExit(rpc, delegated.taskId);
      const attemptsPath = join(
        paths.tasksDir,
        "stop-hook-attempts",
        `${delegated.taskId}.attempts`
      );
      const attempts = existsSync(attemptsPath)
        ? Number.parseInt(readFileSync(attemptsPath, "utf8"), 10)
        : 0;
      expect((task.task.workerStderr ?? "").includes("Stop Blocked") || attempts > 0).toBe(true);
    } finally {
      restoreEnv();
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  }, 240_000);
});

async function runCodexPreflight(model: string): Promise<string> {
  const proc = spawn(
    "codex",
    [
      "codex",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-m",
      model,
      "Reply exactly: codex-fleet-preflight-ok"
    ].slice(1),
    {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const [stdout, stderr, exitCode] = await collectProcess(proc);
  if (exitCode !== 0) {
    throw new Error(`Codex preflight failed for model ${model}: ${stderr}`);
  }
  return stdout;
}

async function collectProcess(proc: ReturnType<typeof spawn>): Promise<[string, string, number]> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  });
  return [
    Buffer.concat(stdoutChunks).toString("utf8"),
    Buffer.concat(stderrChunks).toString("utf8"),
    exitCode
  ];
}

function useCodexBackend(model: string): () => void {
  const previousBackend = process.env.CODEX_FLEET_WORKER_BACKEND;
  const previousTimeout = process.env.CODEX_FLEET_CODEX_TIMEOUT_MS;
  const previousModel = process.env.CODEX_FLEET_E2E_MODEL;
  process.env.CODEX_FLEET_WORKER_BACKEND = "codex";
  process.env.CODEX_FLEET_CODEX_TIMEOUT_MS = previousTimeout ?? "120000";
  process.env.CODEX_FLEET_E2E_MODEL = model;

  return () => {
    restoreEnv("CODEX_FLEET_WORKER_BACKEND", previousBackend);
    restoreEnv("CODEX_FLEET_CODEX_TIMEOUT_MS", previousTimeout);
    restoreEnv("CODEX_FLEET_E2E_MODEL", previousModel);
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function waitForExit(
  rpc: { socketPath: string; clientId: string; token: string },
  taskId: string
): Promise<{
  task: {
    state: string;
    finalResponsePreview?: string;
    worktreePath?: string;
    workerStderr?: string;
  };
}> {
  let sinceEventSeq = 1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const waited = (await callDaemon(rpc, "wait_tasks", {
      taskIds: [taskId],
      sinceEventSeq,
      maxWaitSeconds: 10
    })) as {
      snapshots: Array<{
        state: string;
        finalResponsePreview?: string;
        worktreePath?: string;
        workerStderr?: string;
      }>;
      events: Array<{ seq: number }>;
    };
    sinceEventSeq = Math.max(sinceEventSeq, ...waited.events.map((event) => event.seq));
    const snapshot = waited.snapshots[0];
    if (snapshot?.state === "exited") {
      return (await callDaemon(rpc, "get_task", { taskId })) as {
        task: {
          state: string;
          finalResponsePreview?: string;
          worktreePath?: string;
          workerStderr?: string;
        };
      };
    }
  }
  return (await callDaemon(rpc, "get_task", { taskId })) as {
    task: {
      state: string;
      finalResponsePreview?: string;
      worktreePath?: string;
      workerStderr?: string;
    };
  };
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
