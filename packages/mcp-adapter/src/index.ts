import { callDaemon, readClientToken, resolveFleetPaths } from "@codex-fleet/daemon";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  delegateTaskRequestSchema,
  endTaskRequestSchema,
  getTaskHistoryRequestSchema,
  getTaskRequestSchema,
  initializeRequestSchema,
  listTasksRequestSchema,
  waitTasksRequestSchema,
  type DaemonMethod
} from "@codex-fleet/shared";

type AdapterOptions = {
  clientId: string;
  token: string;
  socketPath: string;
};

export const listTargetsToolDescription =
  "Discover repos and shell targets available to this client, including repo mergePolicy guidance when present. Do not call as a connection preflight or routine first step. If the target alias and delivery boundary are already known, delegate directly; use this only for target discovery, current availability, or missing policy/capability context.";

export function createAdapterServer(options = loadAdapterOptions()): McpServer {
  const server = new McpServer({ name: "codex-fleet-mcp-adapter", version: "0.0.0" });

  registerProxyTool(
    server,
    options,
    "initialize",
    initializeRequestSchema,
    "Declare or reattach to a fleet session."
  );
  registerProxyTool(server, options, "list_targets", z.object({}), listTargetsToolDescription);
  registerProxyTool(
    server,
    options,
    "delegate_task",
    delegateTaskRequestSchema,
    "Start or resume one asynchronous Fleet worker task. Returns immediately with a durable taskId; monitor with wait_tasks rather than blocking here. modelTier is a capability/cost hint: cheap for smoke tests, codebase exploration, read-heavy scans, simple read-only checks, and tiny mechanical work; standard for normal repo tasks and implementation slices; strong for high-risk changes, ambiguous architecture, security-sensitive work, or work likely to require deep judgment. modelRoute is optional concrete model selection: omit for Fleet default gpt-5.6-terra; use gpt-5.5 for conservative fallback, gpt-5.6-luna for fastest/lowest-cost GPT-5.6 work, and gpt-5.6-sol only for the hardest long-horizon, ambiguous, security-sensitive, or high-consequence work. Fleet records requestedModelRoute, actualModelRoute, and workerModel so Sol over-selection can be audited."
  );
  registerProxyTool(
    server,
    options,
    "get_task",
    getTaskRequestSchema,
    "Read one full task snapshot, including retained prompt/output/stderr/resource details. Use after terminal, stale, failed, or unexpected states; do not use for routine polling of quiet running workers."
  );
  registerProxyTool(
    server,
    options,
    "wait_tasks",
    waitTasksRequestSchema,
    "Primary monitoring primitive for active workers. For orchestration, prefer 30-45s maxWaitSeconds, wakeOn=requested_status, terminal/stale returnOnStatuses, snapshotDetail=compact, and the default eventDetail=none. The default returns only small status projections and advances nextEventSeq without replaying prompt, result, stderr, command, or raw event content. Use get_task only after a terminal or unexpected state; use get_task_history for audit/debugging. Carry response.nextEventSeq into the next sinceEventSeq. eventDetail=summary or full is diagnostic-only. wakeOn=any_event preserves immediate activity following behavior; wakeOn=material_event ignores task_activity and task_observation wakes. returnOnStatuses alone does not suppress event wakes unless wakeOn=requested_status. Do not substitute shell sleeps."
  );
  registerProxyTool(
    server,
    options,
    "list_tasks",
    listTasksRequestSchema,
    "List tasks visible to this client."
  );
  registerProxyTool(
    server,
    options,
    "get_task_history",
    getTaskHistoryRequestSchema,
    "Read recent task events when a final response or state transition needs explanation. Use for debugging or audit context, not normal wait-loop polling."
  );
  registerProxyTool(
    server,
    options,
    "end_task",
    endTaskRequestSchema,
    "Release a task when the orchestrator is done with it."
  );

  return server;
}

if (import.meta.main) {
  if (process.argv.includes("--probe")) {
    const server = createAdapterServer({
      clientId: "probe",
      token: "probe",
      socketPath: "/tmp/codex-fleet-probe.sock"
    });
    console.log(JSON.stringify({ ok: true, server: server.constructor.name }));
  } else {
    const server = createAdapterServer();
    await server.connect(new StdioServerTransport());
  }
}

function loadAdapterOptions(): AdapterOptions {
  const paths = resolveFleetPaths();
  const clientId = process.env.CODEX_FLEET_CLIENT_ID ?? "orchestrator";
  return {
    clientId,
    token: process.env.CODEX_FLEET_TOKEN ?? readClientToken(paths, clientId),
    socketPath: paths.socketPath
  };
}

function registerProxyTool<T extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  options: AdapterOptions,
  method: DaemonMethod,
  inputSchema: T,
  description: string
): void {
  server.tool(method, description, inputSchema.shape, async (params) => {
    const result = await callDaemon(options, method, params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  });
}
