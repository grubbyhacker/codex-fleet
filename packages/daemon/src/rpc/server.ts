import { existsSync, rmSync, statSync } from "node:fs";
import net from "node:net";

import { rpcEnvelopeSchema, type DaemonResponse } from "@codex-fleet/shared";

import type { FleetPaths } from "../paths.js";
import { FleetService } from "../service.js";
import type { WorkerBackend } from "../workers/backend.js";
import { appendAuditRecord } from "./audit.js";
import { authenticate, authorize, ensureStateLayout } from "./auth.js";
import { errorResponse } from "./errors.js";
import { verifyPeerUid } from "./peer-credentials.js";

export type RunningDaemon = {
  close: () => Promise<void>;
  socketPath: string;
};

export async function startDaemon(
  paths: FleetPaths,
  workerBackend?: WorkerBackend
): Promise<RunningDaemon> {
  assertNotRoot();
  ensureStateLayout(paths);
  verifyStateLayout(paths);
  if (existsSync(paths.socketPath)) {
    await removeStaleSocket(paths.socketPath);
  }

  const service = new FleetService(paths, workerBackend);
  const server = net.createServer((socket) => {
    socket.pause();
    void attachVerifiedSocket(paths, service, socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, resolve);
  });

  return {
    socketPath: paths.socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (existsSync(paths.socketPath)) {
        rmSync(paths.socketPath);
      }
    }
  };
}

async function attachVerifiedSocket(
  paths: FleetPaths,
  service: FleetService,
  socket: net.Socket
): Promise<void> {
  const peer = await verifyPeerUid(socket);
  if (!peer.ok) {
    appendAuditRecord(paths.auditPath, {
      outcome: "rejected",
      reason: `peer uid rejected: ${peer.reason}`
    });
    socket.destroy();
    return;
  }

  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void handleLine(paths, service, line).then((response) => {
        socket.write(`${JSON.stringify(response)}\n`);
      });
      newline = buffer.indexOf("\n");
    }
  });
  socket.resume();
}

function assertNotRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("codex-fleet daemon must not run as root");
  }
}

function verifyStateLayout(paths: FleetPaths): void {
  const mode = statSync(paths.rootDir).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`codex-fleet state dir must be 0700: ${paths.rootDir} is ${mode.toString(8)}`);
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error(`codex-fleet daemon socket is already active: ${socketPath}`);
  }
  rmSync(socketPath);
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ENOTSOCK") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

async function handleLine(
  paths: FleetPaths,
  service: FleetService,
  line: string
): Promise<DaemonResponse> {
  let requestId: string | undefined;
  let clientId: string | undefined;
  let method: string | undefined;

  try {
    const envelope = rpcEnvelopeSchema.parse(JSON.parse(line));
    requestId = envelope.requestId;
    clientId = envelope.clientId;
    method = envelope.method;
    const client = authenticate(paths, envelope.clientId, envelope.token);
    const authorizedMethod = authorize(client, envelope.method);
    const result = await service.handle(authorizedMethod, envelope, client);
    appendAuditRecord(paths.auditPath, {
      requestId,
      clientId,
      method,
      outcome: "accepted"
    });
    return { requestId, ok: true, result };
  } catch (error) {
    appendAuditRecord(paths.auditPath, {
      requestId,
      clientId,
      method,
      outcome: "rejected",
      reason: error instanceof Error ? error.message : String(error)
    });
    return errorResponse(error, requestId);
  }
}
