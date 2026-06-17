import { homedir } from "node:os";
import { join } from "node:path";

export type FleetPaths = {
  rootDir: string;
  clientsDir: string;
  tasksDir: string;
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
    eventsPath: join(rootDir, "tasks", "events.jsonl"),
    auditPath: join(rootDir, "audit.jsonl"),
    socketPath: process.env.CODEX_FLEET_SOCKET ?? join(rootDir, "daemon.sock")
  };
}
