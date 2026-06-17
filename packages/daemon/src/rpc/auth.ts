import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { daemonMethodSchema, type DaemonMethod } from "@codex-fleet/shared";
import { z } from "zod";

import type { FleetPaths } from "../paths.js";
import { FleetError } from "./errors.js";

export const clientRoleSchema = z.enum(["orchestrator", "dashboard", "cli"]);
export type ClientRole = z.infer<typeof clientRoleSchema>;

export const scopeSchema = z.enum([
  "delegate",
  "wait",
  "get",
  "list",
  "end_task",
  "cleanup",
  "admin"
]);
export type Scope = z.infer<typeof scopeSchema>;

const clientRecordSchema = z.object({
  clientId: z.string().min(1),
  role: clientRoleSchema,
  scopes: z.array(scopeSchema),
  tokenHash: z.string().min(1),
  createdAt: z.string().min(1),
  revokedAt: z.string().min(1).optional()
});
export type ClientRecord = z.infer<typeof clientRecordSchema>;

const methodScopes: Record<DaemonMethod, Scope> = {
  initialize: "get",
  list_targets: "list",
  delegate_task: "delegate",
  get_task: "get",
  wait_tasks: "wait",
  list_tasks: "list",
  get_task_history: "get",
  end_task: "end_task"
};

const roleScopes: Record<ClientRole, Scope[]> = {
  orchestrator: ["delegate", "wait", "get", "list", "end_task"],
  dashboard: ["get", "list"],
  cli: ["delegate", "wait", "get", "list", "end_task", "cleanup", "admin"]
};

export function scopesForRole(role: ClientRole): Scope[] {
  return roleScopes[role];
}

export function requiredScope(method: DaemonMethod): Scope {
  return methodScopes[method];
}

export function ensureStateLayout(paths: FleetPaths): void {
  mkdirSync(paths.rootDir, { mode: 0o700, recursive: true });
  chmodSync(paths.rootDir, 0o700);
  mkdirSync(paths.clientsDir, { mode: 0o700, recursive: true });
  chmodSync(paths.clientsDir, 0o700);
  mkdirSync(paths.tasksDir, { mode: 0o700, recursive: true });
  chmodSync(paths.tasksDir, 0o700);
  mkdirSync(paths.worktreesDir, { mode: 0o700, recursive: true });
  chmodSync(paths.worktreesDir, 0o700);
}

export function tokenPath(paths: FleetPaths, clientId: string): string {
  return join(paths.clientsDir, clientId, "token");
}

export function clientRecordPath(paths: FleetPaths, clientId: string): string {
  return join(paths.clientsDir, clientId, "client.json");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createClient(
  paths: FleetPaths,
  clientId: string,
  role: ClientRole
): { token: string; record: ClientRecord } {
  ensureStateLayout(paths);
  const clientDir = join(paths.clientsDir, clientId);
  mkdirSync(clientDir, { mode: 0o700, recursive: true });
  chmodSync(clientDir, 0o700);

  const token = generateToken();
  const record: ClientRecord = {
    clientId,
    role,
    scopes: scopesForRole(role),
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString()
  };

  writeFileSync(clientRecordPath(paths, clientId), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(clientRecordPath(paths, clientId), 0o600);
  writeFileSync(tokenPath(paths, clientId), `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath(paths, clientId), 0o600);

  return { token, record };
}

export function readClientToken(paths: FleetPaths, clientId: string): string {
  return readFileSync(tokenPath(paths, clientId), "utf8").trim();
}

export function loadClient(paths: FleetPaths, clientId: string): ClientRecord {
  const path = clientRecordPath(paths, clientId);
  if (!existsSync(path)) {
    throw new FleetError("unauthenticated", `Unknown client "${clientId}"`);
  }
  return clientRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function authenticate(paths: FleetPaths, clientId: string, token: string): ClientRecord {
  const record = loadClient(paths, clientId);
  if (record.revokedAt) {
    throw new FleetError("unauthenticated", `Client "${clientId}" token is revoked`);
  }

  const expected = Buffer.from(record.tokenHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new FleetError("unauthenticated", `Invalid token for client "${clientId}"`);
  }

  return record;
}

export function authorize(record: ClientRecord, method: string): DaemonMethod {
  const parsedMethod = daemonMethodSchema.parse(method);
  const scope = requiredScope(parsedMethod);
  if (!record.scopes.includes(scope)) {
    throw new FleetError("forbidden", `Client "${record.clientId}" lacks scope "${scope}"`);
  }
  return parsedMethod;
}
