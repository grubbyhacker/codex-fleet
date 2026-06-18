import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("mcp adapter", () => {
  it("proxies public tools to the daemon without holding state", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-adapter-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const clientRecord = createClient(paths, "adapter-test", "orchestrator");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", "packages/mcp-adapter/src/index.ts"],
      cwd: process.cwd(),
      env: {
        ...stringEnv(process.env),
        CODEX_FLEET_STATE_DIR: root,
        CODEX_FLEET_CLIENT_ID: "adapter-test",
        CODEX_FLEET_TOKEN: clientRecord.token
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "codex-fleet-adapter-test", version: "0.0.0" });

    try {
      await client.connect(transport);
      const initialized = await client.callTool({
        name: "initialize",
        arguments: { sessionName: "adapter" }
      });
      expect(readJsonText(initialized)).toMatchObject({
        accepted: true,
        ownerSession: { clientId: "adapter-test", sessionName: "adapter" }
      });

      const delegated = await client.callTool({
        name: "delegate_task",
        arguments: {
          target: { shell: true },
          deliveryMode: "research_only",
          prompt: "hello through adapter"
        }
      });
      const delegatedJson = readJsonText(delegated) as { taskId: string };
      expect(delegatedJson.taskId).toBeTruthy();
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("can restart while a fake task is in flight without losing daemon state", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-adapter-restart-"));
    const paths = resolveFleetPaths(root);
    const previousDelay = process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS;
    process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS = "250";
    const daemon = await startDaemon(paths);
    const clientRecord = createClient(paths, "adapter-restart", "orchestrator");

    let firstClient: Client | undefined;
    let secondClient: Client | undefined;

    try {
      firstClient = await connectAdapter(root, clientRecord.token);
      await firstClient.callTool({
        name: "initialize",
        arguments: { sessionName: "adapter-restart" }
      });
      const delegated = readJsonText(
        await firstClient.callTool({
          name: "delegate_task",
          arguments: {
            target: { shell: true },
            deliveryMode: "research_only",
            prompt: "restart while running"
          }
        })
      ) as { taskId: string };
      await firstClient.close();
      firstClient = undefined;

      secondClient = await connectAdapter(root, clientRecord.token);
      const waited = readJsonText(
        await secondClient.callTool({
          name: "wait_tasks",
          arguments: {
            taskIds: [delegated.taskId],
            sinceEventSeq: 999,
            returnOnStatuses: ["exited"],
            maxWaitSeconds: 1
          }
        })
      ) as { snapshots: Array<{ id: string; state: string }> };
      expect(waited.snapshots).toContainEqual(
        expect.objectContaining({ id: delegated.taskId, state: "exited" })
      );
    } finally {
      if (previousDelay === undefined) {
        delete process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS;
      } else {
        process.env.CODEX_FLEET_FAKE_WORKER_DELAY_MS = previousDelay;
      }
      await firstClient?.close().catch(() => undefined);
      await secondClient?.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function connectAdapter(root: string, token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "packages/mcp-adapter/src/index.ts"],
    cwd: process.cwd(),
    env: {
      ...stringEnv(process.env),
      CODEX_FLEET_STATE_DIR: root,
      CODEX_FLEET_CLIENT_ID: "adapter-restart",
      CODEX_FLEET_TOKEN: token
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "codex-fleet-adapter-restart-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function readJsonText(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (!first || first.type !== "text") {
    throw new Error("Expected text tool result");
  }
  if (!first.text) {
    throw new Error("Expected text content");
  }
  return JSON.parse(first.text);
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}
