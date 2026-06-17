import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createAdapterServer(): McpServer {
  return new McpServer({ name: "codex-fleet-mcp-adapter", version: "0.0.0" });
}

if (process.argv.includes("--probe")) {
  const server = createAdapterServer();
  console.log(JSON.stringify({ ok: true, server: server.constructor.name }));
}
