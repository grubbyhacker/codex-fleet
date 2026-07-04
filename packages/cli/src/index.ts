import {
  callDaemon,
  clientRoleSchema,
  createClient,
  readClientToken,
  RepoRegistry,
  resolveGitExecutable,
  resolveFleetPaths,
  startDaemon
} from "@codex-fleet/daemon";
import type { TaskSnapshot } from "@codex-fleet/shared";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function cliProbe(): { ok: true; command: string } {
  return { ok: true, command: "codex-fleet" };
}

if (import.meta.main) {
  if (process.argv.includes("--probe")) {
    console.log(JSON.stringify(cliProbe()));
  }

  const [command, subcommand, ...args] = process.argv.slice(2);

  if (command === "client" && subcommand === "init") {
    const clientId = args[0];
    const roleIndex = args.indexOf("--role");
    const role = roleIndex === -1 ? "orchestrator" : args[roleIndex + 1];
    if (!clientId) {
      throw new Error(
        "Usage: codex-fleet client init <clientId> --role <orchestrator|dashboard|cli>"
      );
    }

    const result = createClient(resolveFleetPaths(), clientId, clientRoleSchema.parse(role));
    console.log(
      JSON.stringify(
        {
          clientId: result.record.clientId,
          role: result.record.role,
          scopes: result.record.scopes,
          tokenPath: `${resolveFleetPaths().clientsDir}/${clientId}/token`
        },
        null,
        2
      )
    );
  }

  if (command === "daemon" && subcommand === "run") {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.error("codex-fleet daemon must not run as root");
      process.exit(1);
    }

    const daemon = await startDaemon(resolveFleetPaths());
    console.error(`codex-fleet daemon listening on ${daemon.socketPath}`);
    const stop = async () => {
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  }

  if (command === "list") {
    console.log(JSON.stringify(await callDaemon(loadRpcOptions(), "list_tasks", {}), null, 2));
  }

  if (command === "status") {
    const taskId = subcommand;
    if (!taskId) {
      throw new Error("Usage: codex-fleet status <taskId>");
    }
    console.log(
      JSON.stringify(await callDaemon(loadRpcOptions(), "get_task", { taskId }), null, 2)
    );
  }

  if (command === "logs") {
    const taskId = subcommand;
    if (!taskId) {
      throw new Error("Usage: codex-fleet logs <taskId>");
    }
    console.log(
      JSON.stringify(await callDaemon(loadRpcOptions(), "get_task_history", { taskId }), null, 2)
    );
  }

  if (command === "watch") {
    const taskId = subcommand;
    if (!taskId) {
      throw new Error("Usage: codex-fleet watch <taskId>");
    }
    console.log(
      JSON.stringify(
        await callDaemon(loadRpcOptions(), "wait_tasks", {
          taskIds: [taskId],
          maxWaitSeconds: Number(process.env.CODEX_FLEET_WATCH_SECONDS ?? "5")
        }),
        null,
        2
      )
    );
  }

  if (command === "cleanup" && subcommand === "list") {
    if (!args.includes("--dry-run")) {
      throw new Error("Usage: codex-fleet cleanup list --dry-run");
    }
    console.log(JSON.stringify(await listCleanupCandidates(), null, 2));
  }

  if (command === "cleanup" && subcommand === "run") {
    const taskIndex = args.indexOf("--task");
    const taskId = taskIndex === -1 ? undefined : args[taskIndex + 1];
    if (!taskId) {
      throw new Error("Usage: codex-fleet cleanup run --task <taskId> [--dry-run] [--force]");
    }
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify(await dryRunCleanup(taskId), null, 2));
      process.exit(0);
    }
    const force = args.includes("--force");
    const result = force
      ? await forceCleanup(taskId)
      : await callDaemon(loadRpcOptions(), "end_task", {
          taskId: await resolveTaskIdOrPrefix(taskId)
        });
    console.log(JSON.stringify(result, null, 2));
  }

  if (command === "cleanup" && subcommand === "wipe-clean") {
    const dryRun = args.includes("--dry-run");
    console.log(JSON.stringify(await wipeCleanActionQueue({ dryRun }), null, 2));
  }

  if (command === "service" && subcommand === "launch-agent") {
    const action = args[0];
    if (action === "print") {
      process.stdout.write(renderLaunchAgentPlist());
    } else if (action === "install") {
      console.log(JSON.stringify(installLaunchAgent(), null, 2));
    } else if (action === "load") {
      console.log(JSON.stringify(loadLaunchAgent(), null, 2));
    } else if (action === "unload") {
      console.log(JSON.stringify(unloadLaunchAgent(), null, 2));
    } else if (action === "restart") {
      const installed = installLaunchAgent();
      unloadLaunchAgent({ ignoreMissing: true });
      console.log(JSON.stringify({ ...installed, ...loadLaunchAgent(), restarted: true }, null, 2));
    } else if (action === "status") {
      console.log(JSON.stringify(launchAgentStatus(), null, 2));
    } else if (action === "uninstall") {
      const plistPath = launchAgentPath();
      rmSync(plistPath, { force: true });
      console.log(JSON.stringify({ uninstalled: true, plistPath }, null, 2));
    } else {
      throw new Error(
        "Usage: codex-fleet service launch-agent <print|install|load|unload|restart|status|uninstall>"
      );
    }
  }
}

function loadRpcOptions(): { socketPath: string; clientId: string; token: string } {
  const paths = resolveFleetPaths();
  const clientId = process.env.CODEX_FLEET_CLIENT_ID ?? "cli";
  return {
    socketPath: paths.socketPath,
    clientId,
    token: process.env.CODEX_FLEET_TOKEN ?? readClientToken(paths, clientId)
  };
}

async function listCleanupCandidates(): Promise<{
  dryRun: true;
  candidates: CleanupCandidate[];
}> {
  const result = (await callDaemon(loadRpcOptions(), "list_tasks", {})) as {
    tasks: TaskSnapshot[];
  };
  return {
    dryRun: true,
    candidates: result.tasks
      .filter((task) => task.worktreePath && isTerminal(task.state))
      .map((task) => classifyCleanupCandidate(task))
  };
}

type ListedTask = TaskSnapshot & { id: string };

async function listTerminalWorktreeTasks(): Promise<ListedTask[]> {
  const result = (await callDaemon(loadRpcOptions(), "list_tasks", {})) as {
    tasks: TaskSnapshot[];
  };
  return result.tasks
    .filter((task): task is ListedTask => Boolean(task.id && task.worktreePath))
    .filter((task) => isTerminal(task.state));
}

async function dryRunCleanup(taskId: string): Promise<{
  dryRun: true;
  taskId: string;
  candidate: CleanupCandidate;
}> {
  const result = await getTaskByIdOrPrefix(taskId);
  if (!result.task.worktreePath) {
    throw new Error(`Task "${taskId}" has no worktree to clean`);
  }
  return {
    dryRun: true,
    taskId,
    candidate: classifyCleanupCandidate(result.task)
  };
}

async function wipeCleanActionQueue(options: { dryRun: boolean }): Promise<{
  dryRun: boolean;
  targets: CleanupCandidate[];
  wiped: Array<ForceCleanupResult & { candidate: CleanupCandidate }>;
  skipped: CleanupCandidate[];
}> {
  const candidates = (await listTerminalWorktreeTasks()).map((task) =>
    classifyCleanupCandidate(task)
  );
  const wipeTargets = candidates.filter((candidate) => candidate.status !== "already_removed");
  if (options.dryRun) {
    return {
      dryRun: true,
      skipped: candidates.filter(isAlreadyRemoved),
      targets: wipeTargets,
      wiped: []
    };
  }

  const wiped: Array<ForceCleanupResult & { candidate: CleanupCandidate }> = [];
  for (const candidate of wipeTargets) {
    wiped.push({ ...(await forceCleanup(candidate.taskId)), candidate });
  }
  return { dryRun: false, skipped: candidates.filter(isAlreadyRemoved), targets: [], wiped };
}

function isAlreadyRemoved(candidate: CleanupCandidate): boolean {
  return candidate.status === "already_removed";
}

type CleanupCandidate = {
  taskId: string;
  state: TaskSnapshot["state"];
  worktreePath: string;
  branch?: string;
  status: "cleanup_ready" | "cleanup_blocked_dirty" | "already_removed";
  dirtyFiles: number;
  action: "cleanup run --task" | "inspect | archive_patch | cleanup run --task --force" | "none";
};

function classifyCleanupCandidate(task: TaskSnapshot): CleanupCandidate {
  const worktreePath = task.worktreePath ?? "";
  if (!existsSync(worktreePath)) {
    return {
      taskId: task.id,
      state: task.state,
      worktreePath,
      branch: task.branch,
      status: "already_removed",
      dirtyFiles: 0,
      action: "none"
    };
  }

  const dirtyFiles = dirtyFileCount(worktreePath);
  return {
    taskId: task.id,
    state: task.state,
    worktreePath,
    branch: task.branch,
    status: dirtyFiles > 0 ? "cleanup_blocked_dirty" : "cleanup_ready",
    dirtyFiles,
    action:
      dirtyFiles > 0 ? "inspect | archive_patch | cleanup run --task --force" : "cleanup run --task"
  };
}

type ForceCleanupResult = {
  accepted: true;
  taskId: string;
  cleanup: { cleaned: boolean; forced: true; branchDeleted: boolean };
};

async function forceCleanup(taskId: string): Promise<ForceCleanupResult> {
  const result = await getTaskByIdOrPrefix(taskId);
  const task = result.task;
  if (!task.worktreePath) {
    throw new Error(`Task "${taskId}" has no worktree to clean`);
  }
  if (!("repo" in task.target)) {
    throw new Error(`Task "${taskId}" is not a repo task`);
  }
  const repo = loadRepoOwnerPath(resolveFleetPaths(), task.target.repo);
  const git = resolveGitExecutable();
  execFileSync(git, ["worktree", "remove", "--force", task.worktreePath], {
    cwd: repo.baseCheckout,
    stdio: "ignore"
  });
  execFileSync(git, ["worktree", "prune"], { cwd: repo.baseCheckout, stdio: "ignore" });
  const branchDeleted = task.branch ? deleteBranch(repo.baseCheckout, task.branch, true) : false;
  return { accepted: true, taskId, cleanup: { cleaned: true, forced: true, branchDeleted } };
}

async function getTaskByIdOrPrefix(taskId: string): Promise<{ task: TaskSnapshot }> {
  return (await callDaemon(loadRpcOptions(), "get_task", {
    taskId: await resolveTaskIdOrPrefix(taskId)
  })) as {
    task: TaskSnapshot;
  };
}

async function resolveTaskIdOrPrefix(taskId: string): Promise<string> {
  try {
    await callDaemon(loadRpcOptions(), "get_task", { taskId });
    return taskId;
  } catch {
    const matches = (await listTerminalWorktreeTasks()).filter((task) =>
      task.id.startsWith(taskId)
    );
    const match = matches[0];
    if (matches.length === 1 && match) {
      return match.id;
    }
    if (matches.length > 1) {
      throw new Error(`Task id prefix "${taskId}" is ambiguous`);
    }
    return taskId;
  }
}

function loadRepoOwnerPath(
  paths: ReturnType<typeof resolveFleetPaths>,
  alias: string
): { baseCheckout: string } {
  const repo = RepoRegistry.load(paths).get(alias);
  if (!repo) {
    throw new Error(`Unknown repo target "${alias}" in ${paths.reposPath}`);
  }
  const baseCheckout = repo.remoteUrl
    ? (repo.mirrorPath ?? join(paths.reposDir, `${repo.alias}.git`))
    : repo.baseCheckout;
  if (!baseCheckout) {
    throw new Error(`Repo target "${alias}" has no remoteUrl or baseCheckout`);
  }
  return { baseCheckout };
}

function dirtyFileCount(worktreePath: string): number {
  return execFileSync(resolveGitExecutable(), ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8"
  })
    .trim()
    .split("\n")
    .filter(Boolean).length;
}

function deleteBranch(baseCheckout: string, branch: string, force = false): boolean {
  try {
    execFileSync(resolveGitExecutable(), ["branch", force ? "-D" : "-d", branch], {
      cwd: baseCheckout,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function isTerminal(state: TaskSnapshot["state"]): boolean {
  return ["exited", "failed_to_start", "cancelled", "timed_out"].includes(state);
}

export function renderLaunchAgentPlist(): string {
  const paths = resolveFleetPaths();
  const daemonPath = launchAgentDaemonPath();
  const envVars = launchAgentEnvironment();
  const env =
    envVars.length > 0
      ? `
  <key>EnvironmentVariables</key>
  <dict>
${envVars
  .map(
    ([key, value]) => `    <key>${escapePlist(key)}</key>
    <string>${escapePlist(value)}</string>`
  )
  .join("\n")}
  </dict>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.codex-fleet.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(daemonPath)}</string>
    <string>run</string>
  </array>${env}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(join(paths.rootDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(join(paths.rootDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "dev.codex-fleet.daemon.plist");
}

function launchAgentDaemonPath(): string {
  return (
    process.env.CODEX_FLEET_DAEMON_BIN ?? join(homedir(), ".local", "bin", "codex-fleet-daemon")
  );
}

function launchAgentEnvironment(): Array<[string, string]> {
  const defaults = new Map<string, string>([
    [
      "PATH",
      [
        join(homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin"
      ].join(":")
    ],
    ["CODEX_FLEET_WORKER_BACKEND", "codex"],
    ["CODEX_FLEET_CODEX_COMMAND", "/Applications/Codex.app/Contents/Resources/codex"]
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value && key !== "PATH") {
      defaults.set(key, value);
    }
  }
  return [
    "PATH",
    "CODEX_FLEET_STATE_DIR",
    "CODEX_FLEET_WORKER_BACKEND",
    "CODEX_FLEET_CODEX_MODEL",
    "CODEX_FLEET_CODEX_COMMAND",
    "CODEX_FLEET_CODEX_TIMEOUT_MS",
    "CODEX_FLEET_AVAILABLE_MODEL_TIERS"
  ].flatMap((key) => {
    const value = defaults.get(key);
    return value ? [[key, value]] : [];
  });
}

function installLaunchAgent(): { installed: true; plistPath: string; daemonPath: string } {
  const plistPath = launchAgentPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderLaunchAgentPlist(), { mode: 0o644 });
  return { installed: true, plistPath, daemonPath: launchAgentDaemonPath() };
}

function loadLaunchAgent(): { loaded: true; label: string; domain: string; plistPath: string } {
  ensureMacosLaunchctl();
  const domain = launchAgentDomain();
  const plistPath = launchAgentPath();
  execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "pipe" });
  return { loaded: true, label: launchAgentLabel(), domain, plistPath };
}

function unloadLaunchAgent(options: { ignoreMissing?: boolean } = {}): {
  unloaded: true;
  label: string;
  domain: string;
  plistPath: string;
} {
  ensureMacosLaunchctl();
  const domain = launchAgentDomain();
  const plistPath = launchAgentPath();
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "pipe" });
  } catch (error) {
    if (!options.ignoreMissing) {
      throw error;
    }
  }
  return { unloaded: true, label: launchAgentLabel(), domain, plistPath };
}

function launchAgentStatus(): {
  label: string;
  domain: string;
  plistPath: string;
  running: boolean;
  state?: string;
  pid?: number;
  programArguments: string[];
  raw?: string;
} {
  ensureMacosLaunchctl();
  const service = `${launchAgentDomain()}/${launchAgentLabel()}`;
  const programArguments = [launchAgentDaemonPath(), "run"];
  try {
    const raw = execFileSync("launchctl", ["print", service], { encoding: "utf8" });
    const state = raw.match(/state = (.+)/)?.[1]?.trim();
    const pidText = raw.match(/pid = ([0-9]+)/)?.[1];
    return {
      label: launchAgentLabel(),
      domain: launchAgentDomain(),
      plistPath: launchAgentPath(),
      running: state === "running" || Boolean(pidText),
      state,
      pid: pidText ? Number(pidText) : undefined,
      programArguments,
      raw
    };
  } catch {
    return {
      label: launchAgentLabel(),
      domain: launchAgentDomain(),
      plistPath: launchAgentPath(),
      running: false,
      programArguments
    };
  }
}

function ensureMacosLaunchctl(): void {
  if (process.platform !== "darwin") {
    throw new Error("LaunchAgent commands are only supported on macOS");
  }
}

function launchAgentDomain(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("Cannot determine launchd user domain on this platform");
  }
  return `gui/${process.getuid()}`;
}

function launchAgentLabel(): string {
  return "dev.codex-fleet.daemon";
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
