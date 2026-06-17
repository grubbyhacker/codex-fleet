import { homedir } from "node:os";
import { join } from "node:path";

export type FleetPaths = {
  rootDir: string;
  clientsDir: string;
  tasksDir: string;
  worktreesDir: string;
  reposPath: string;
  eventsPath: string;
  auditPath: string;
  socketPath: string;
};

export function defaultFleetRoot(): string {
  return process.env.CODEX_FLEET_STATE_DIR ?? join(homedir(), ".codex-fleet");
}

export function resolveFleetPaths(rootDir = defaultFleetRoot()): FleetPaths {
  return {
    rootDir,
    clientsDir: join(rootDir, "clients"),
    tasksDir: join(rootDir, "tasks"),
    worktreesDir: join(rootDir, "worktrees"),
    reposPath: join(rootDir, "repos.json"),
    eventsPath: join(rootDir, "tasks", "events.jsonl"),
    auditPath: join(rootDir, "audit.jsonl"),
    socketPath: process.env.CODEX_FLEET_SOCKET ?? join(rootDir, "daemon.sock")
  };
}
