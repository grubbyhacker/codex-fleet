import {
  callDaemon,
  clientRoleSchema,
  createClient,
  readClientToken,
  resolveFleetPaths,
  startDaemon
} from "@codex-fleet/daemon";
import type { TaskSnapshot } from "@codex-fleet/shared";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      throw new Error("Usage: codex-fleet cleanup run --task <taskId> [--force]");
    }
    const force = args.includes("--force");
    const result = force
      ? await forceCleanup(taskId)
      : await callDaemon(loadRpcOptions(), "end_task", { taskId });
    console.log(JSON.stringify(result, null, 2));
  }

  if (command === "service" && subcommand === "launch-agent") {
    const action = args[0];
    if (action === "print") {
      process.stdout.write(renderLaunchAgentPlist());
    } else if (action === "install") {
      const plistPath = launchAgentPath();
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, renderLaunchAgentPlist(), { mode: 0o644 });
      console.log(JSON.stringify({ installed: true, plistPath }, null, 2));
    } else if (action === "uninstall") {
      const plistPath = launchAgentPath();
      rmSync(plistPath, { force: true });
      console.log(JSON.stringify({ uninstalled: true, plistPath }, null, 2));
    } else {
      throw new Error("Usage: codex-fleet service launch-agent <print|install|uninstall>");
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

async function forceCleanup(taskId: string): Promise<{
  accepted: true;
  taskId: string;
  cleanup: { cleaned: boolean; forced: true; branchDeleted: boolean };
}> {
  const result = (await callDaemon(loadRpcOptions(), "get_task", { taskId })) as {
    task: TaskSnapshot;
  };
  const task = result.task;
  if (!task.worktreePath) {
    throw new Error(`Task "${taskId}" has no worktree to clean`);
  }
  if (!("repo" in task.target)) {
    throw new Error(`Task "${taskId}" is not a repo task`);
  }
  const repo = loadRepoBaseCheckout(resolveFleetPaths(), task.target.repo);
  execFileSync("git", ["worktree", "remove", "--force", task.worktreePath], {
    cwd: repo.baseCheckout,
    stdio: "ignore"
  });
  execFileSync("git", ["worktree", "prune"], { cwd: repo.baseCheckout, stdio: "ignore" });
  const branchDeleted = task.branch ? deleteBranchIfMerged(repo.baseCheckout, task.branch) : false;
  return { accepted: true, taskId, cleanup: { cleaned: true, forced: true, branchDeleted } };
}

function loadRepoBaseCheckout(
  paths: ReturnType<typeof resolveFleetPaths>,
  alias: string
): { baseCheckout: string } {
  const registry = JSON.parse(readFileSync(paths.reposPath, "utf8")) as {
    repos?: Array<{ alias: string; baseCheckout: string }>;
  };
  const repo = registry.repos?.find((entry) => entry.alias === alias);
  if (!repo) {
    throw new Error(`Unknown repo target "${alias}" in ${paths.reposPath}`);
  }
  return repo;
}

function dirtyFileCount(worktreePath: string): number {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8"
  })
    .trim()
    .split("\n")
    .filter(Boolean).length;
}

function deleteBranchIfMerged(baseCheckout: string, branch: string): boolean {
  try {
    execFileSync("git", ["branch", "-d", branch], { cwd: baseCheckout, stdio: "ignore" });
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
  const cliPath = fileURLToPath(import.meta.url);
  const env = process.env.CODEX_FLEET_STATE_DIR
    ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_FLEET_STATE_DIR</key>
    <string>${escapePlist(process.env.CODEX_FLEET_STATE_DIR)}</string>
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
    <string>${escapePlist(process.execPath)}</string>
    <string>run</string>
    <string>${escapePlist(cliPath)}</string>
    <string>daemon</string>
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

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
