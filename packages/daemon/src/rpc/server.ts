import { existsSync, rmSync } from "node:fs";
import net from "node:net";

import { rpcEnvelopeSchema, type DaemonResponse } from "@codex-fleet/shared";

import type { FleetPaths } from "../paths.js";
import { FleetService } from "../service.js";
import { appendAuditRecord } from "./audit.js";
import { authenticate, authorize, ensureStateLayout } from "./auth.js";
import { errorResponse } from "./errors.js";

export type RunningDaemon = {
  close: () => Promise<void>;
  socketPath: string;
};

export async function startDaemon(paths: FleetPaths): Promise<RunningDaemon> {
  ensureStateLayout(paths);
  if (existsSync(paths.socketPath)) {
    rmSync(paths.socketPath);
  }

  const service = new FleetService(paths);
  const server = net.createServer((socket) => {
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
    const result = service.handle(authorizedMethod, envelope);
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
