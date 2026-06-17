import { randomUUID } from "node:crypto";
import net from "node:net";

import { daemonResponseSchema, type DaemonMethod } from "@codex-fleet/shared";

export type RpcClientOptions = {
  socketPath: string;
  clientId: string;
  token: string;
};

export async function callDaemon(
  options: RpcClientOptions,
  method: DaemonMethod,
  params?: unknown
): Promise<unknown> {
  const requestId = randomUUID();
  const response = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          requestId,
          clientId: options.clientId,
          token: options.token,
          method,
          params
        })}\n`
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        socket.end();
      }
    });
    socket.on("end", () => resolve(buffer.trim()));
    socket.on("error", reject);
  });

  const parsed = daemonResponseSchema.parse(JSON.parse(response));
  if (!parsed.ok) {
    const suffix = parsed.error.nextCall ? ` Next call: ${parsed.error.nextCall}.` : "";
    throw new Error(`${parsed.error.code}: ${parsed.error.message}.${suffix}`);
  }
  return parsed.result;
}
