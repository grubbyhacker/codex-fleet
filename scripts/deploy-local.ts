import { callDaemon, readClientToken, resolveFleetPaths } from "@codex-fleet/daemon";
import type { TaskSnapshot } from "@codex-fleet/shared";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runDeployWorkerSmoke } from "./deploy-worker-smoke.js";

type AdapterProcess = {
  pid: number;
  ppid: number;
  elapsed: string;
  command: string;
};

const args = new Set(process.argv.slice(2));
const allowActive = args.has("--allow-active");
const skipDaemonRestart = args.has("--skip-daemon-restart");
const skipSkill = args.has("--skip-skill");
const skipWorkerSmoke = args.has("--skip-worker-smoke");
const staleFreshMs = Number(process.env.CODEX_FLEET_DEPLOY_FRESH_STALE_MS ?? 60 * 60 * 1000);
const installDir = process.env.CODEX_FLEET_INSTALL_BIN_DIR ?? join(homedir(), ".local", "bin");
const fleetCli = join(installDir, "codex-fleet");

if (args.has("--help")) {
  process.stdout
    .write(`Usage: bun run deploy:local [--allow-active] [--skip-daemon-restart] [--skip-skill] [--skip-worker-smoke]

Build and deploy local Codex Fleet binaries predictably.

Behavior:
- checks queued/running/fresh-stale Fleet tasks before daemon restart;
- builds and installs binaries;
- installs the use-codex-fleet skill for Codex and Claude unless --skip-skill is passed;
- restarts only the LaunchAgent daemon unless --skip-daemon-restart is passed;
- runs a paid, minimal Luna worker through the installed daemon unless --skip-worker-smoke is passed;
- never kills codex-fleet-mcp adapter processes.

Existing MCP clients keep their current stdio adapter until they reconnect.
`);
  process.exit(0);
}

const taskPreflight = await readActiveTasks();
if (taskPreflight.active.length > 0 && !allowActive) {
  process.stderr.write("Refusing local deploy because Fleet has active or fresh-stale tasks:\n");
  for (const task of taskPreflight.active) {
    process.stderr.write(`- ${task.id} ${task.state} ${JSON.stringify(task.target)}\n`);
  }
  process.stderr.write(
    "Re-run with --allow-active only after the operator approves interruption.\n"
  );
  process.exit(1);
}

if (taskPreflight.ignoredOldStale.length > 0) {
  process.stdout.write(
    `Ignoring ${taskPreflight.ignoredOldStale.length} old stale task(s) older than ${staleFreshMs}ms.\n`
  );
}

const beforeAdapters = listAdapterProcesses();
if (beforeAdapters.length > 0) {
  process.stdout.write(
    `Leaving ${beforeAdapters.length} client-owned codex-fleet-mcp adapter process(es) running.\n`
  );
}

runStep("build binaries", [process.execPath, "run", "build:bin"]);
runStep("install binaries", [process.execPath, "run", "scripts/install-bin.ts"]);

if (!skipSkill) {
  runStep("install Fleet skill", [process.execPath, "run", "scripts/install-fleet-skill.ts"]);
}

let daemonStatus: unknown = { skipped: true };
let workerSmoke: unknown = { skipped: true };
if (!skipDaemonRestart) {
  if (!existsSync(fleetCli)) {
    throw new Error(`Installed codex-fleet CLI not found after install: ${fleetCli}`);
  }
  runStep("restart LaunchAgent daemon", [fleetCli, "service", "launch-agent", "restart"]);
  daemonStatus = readJsonStep("read LaunchAgent status", [
    fleetCli,
    "service",
    "launch-agent",
    "status"
  ]);
  if (!skipWorkerSmoke) {
    process.stdout.write("\n==> run installed-daemon worker smoke\n");
    const paths = resolveFleetPaths();
    const rpc = {
      socketPath: paths.socketPath,
      clientId: "cli",
      token: readClientToken(paths, "cli")
    };
    workerSmoke = await runDeployWorkerSmoke({
      call: (method, params) => callDaemon(rpc, method, params)
    });
    process.stdout.write(`${JSON.stringify(workerSmoke, null, 2)}\n`);
  }
} else if (!skipWorkerSmoke) {
  process.stdout.write(
    "Worker smoke skipped because --skip-daemon-restart was passed; it only validates a freshly restarted installed daemon.\n"
  );
}

const afterAdapters = listAdapterProcesses();
if (afterAdapters.length > 0) {
  process.stdout.write(
    "MCP adapter note: existing clients still use their already-launched adapter. " +
      "Restart/reconnect the MCP client to load the newly installed adapter binary.\n"
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      deployed: true,
      activeTaskCount: taskPreflight.active.length,
      ignoredOldStaleTaskCount: taskPreflight.ignoredOldStale.length,
      adapterProcesses: afterAdapters,
      daemonStatus,
      workerSmoke
    },
    null,
    2
  )}\n`
);

async function readActiveTasks(): Promise<{
  active: TaskSnapshot[];
  ignoredOldStale: TaskSnapshot[];
}> {
  try {
    const paths = resolveFleetPaths();
    const result = (await callDaemon(
      {
        socketPath: paths.socketPath,
        clientId: "cli",
        token: readClientToken(paths, "cli")
      },
      "list_tasks",
      {}
    )) as { tasks: TaskSnapshot[] };
    const now = Date.now();
    const active: TaskSnapshot[] = [];
    const ignoredOldStale: TaskSnapshot[] = [];
    for (const task of result.tasks) {
      if (task.state === "queued" || task.state === "running") {
        active.push(task);
        continue;
      }
      if (task.state === "stale") {
        const lastActivity = Date.parse(task.lastActivityAt ?? task.updatedAt ?? task.createdAt);
        if (Number.isFinite(lastActivity) && now - lastActivity <= staleFreshMs) {
          active.push(task);
        } else {
          ignoredOldStale.push(task);
        }
      }
    }
    return { active, ignoredOldStale };
  } catch (error) {
    process.stdout.write(
      `Fleet task preflight could not read daemon state; proceeding with install and restart: ${formatError(error)}\n`
    );
    return { active: [], ignoredOldStale: [] };
  }
}

function runStep(label: string, command: string[]): void {
  process.stdout.write(`\n==> ${label}\n`);
  const proc = Bun.spawnSync({
    cmd: command,
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit"
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${proc.exitCode}`);
  }
}

function readJsonStep(label: string, command: string[]): unknown {
  process.stdout.write(`\n==> ${label}\n`);
  const proc = Bun.spawnSync({
    cmd: command,
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "inherit"
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${proc.exitCode}`);
  }
  const text = proc.stdout.toString();
  process.stdout.write(text);
  return JSON.parse(text) as unknown;
}

function listAdapterProcesses(): AdapterProcess[] {
  const proc = Bun.spawnSync({
    cmd: ["ps", "-axo", "pid=,ppid=,etime=,command="],
    stdout: "pipe",
    stderr: "pipe"
  });
  if (proc.exitCode !== 0) {
    return [];
  }
  return proc.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(join(installDir, "codex-fleet-mcp")))
    .map(parseProcessLine)
    .filter((processLine): processLine is AdapterProcess => Boolean(processLine));
}

function parseProcessLine(line: string): AdapterProcess | undefined {
  const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) {
    return undefined;
  }
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    elapsed: match[3] ?? "",
    command: match[4] ?? ""
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
