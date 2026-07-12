import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("model tier routing", () => {
  it("records concrete worker model and route settings for default tasks", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-model-worker-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        risk: "low",
        modelTier: "cheap",
        prompt: "cheap research"
      })) as { taskId: string };
      const result = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: {
          requestedModel?: string;
          actualModel?: string;
          requestedModelRoute?: string;
          actualModelRoute?: string;
          workerModel?: string;
          workerReasoningEffort?: string;
        };
      };

      expect(result.task.requestedModel).toBe("cheap");
      expect(result.task.actualModel).toBe("cheap");
      expect(result.task.requestedModelRoute).toBeUndefined();
      expect(result.task.actualModelRoute).toBe("fleet-default");
      expect(result.task.workerModel).toBe("gpt-5.6-terra");
      expect(result.task.workerReasoningEffort).toBe("medium");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("records explicit GPT-5.6 route choices from orchestrators", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-model-route-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        risk: "standard",
        modelTier: "standard",
        modelRoute: "gpt-5.6-sol",
        prompt: "sol research"
      })) as { taskId: string };
      const result = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: {
          requestedModelRoute?: string;
          actualModelRoute?: string;
          workerModel?: string;
        };
      };

      expect(result.task.requestedModelRoute).toBe("gpt-5.6-sol");
      expect(result.task.actualModelRoute).toBe("gpt-5.6-sol");
      expect(result.task.workerModel).toBe("gpt-5.6-sol");

      const history = (await callDaemon(rpc, "get_task_history", {
        taskId: delegated.taskId
      })) as { events: Array<{ type: string; summary: string }> };
      expect(history.events).toContainEqual(
        expect.objectContaining({
          type: "model_route",
          summary: expect.stringContaining("gpt-5.6-sol")
        })
      );
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("falls back and records actual route when a requested route is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-model-route-fallback-"));
    const previousAvailable = process.env.CODEX_FLEET_AVAILABLE_MODEL_ROUTES;
    process.env.CODEX_FLEET_AVAILABLE_MODEL_ROUTES = "fleet-default,gpt-5.5,gpt-5.6-luna";
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        risk: "standard",
        modelRoute: "gpt-5.6-sol",
        prompt: "sol unavailable"
      })) as { taskId: string };
      const result = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: {
          requestedModelRoute?: string;
          actualModelRoute?: string;
          workerModel?: string;
        };
      };

      expect(result.task.requestedModelRoute).toBe("gpt-5.6-sol");
      expect(result.task.actualModelRoute).toBe("fleet-default");
      expect(result.task.workerModel).toBe("gpt-5.6-terra");
    } finally {
      restoreAvailableModelRoutes(previousAvailable);
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("records requested and actual model tier with safe upgrades", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-model-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "full_delivery",
        risk: "high",
        modelTier: "cheap",
        prompt: "high risk"
      })) as { taskId: string };
      const result = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { requestedModel?: string; actualModel?: string };
      };

      expect(result.task.requestedModel).toBe("cheap");
      expect(result.task.actualModel).toBe("strong");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("records fallback events when a requested tier is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-model-fallback-"));
    const previousAvailable = process.env.CODEX_FLEET_AVAILABLE_MODEL_TIERS;
    process.env.CODEX_FLEET_AVAILABLE_MODEL_TIERS = "standard,strong";
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      const delegated = (await callDaemon(rpc, "delegate_task", {
        target: { shell: true },
        deliveryMode: "research_only",
        risk: "low",
        modelTier: "cheap",
        prompt: "cheap unavailable"
      })) as { taskId: string };
      const result = (await callDaemon(rpc, "get_task", { taskId: delegated.taskId })) as {
        task: { requestedModel?: string; actualModel?: string };
      };
      expect(result.task.requestedModel).toBe("cheap");
      expect(result.task.actualModel).toBe("standard");

      const history = (await callDaemon(rpc, "get_task_history", {
        taskId: delegated.taskId
      })) as { events: Array<{ type: string; summary: string }> };
      expect(history.events).toContainEqual(
        expect.objectContaining({
          type: "model_routing",
          summary: expect.stringContaining("requested_unavailable_fallback")
        })
      );
    } finally {
      restoreAvailableModelTiers(previousAvailable);
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects high-risk work when no strong tier is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-model-reject-"));
    const previousAvailable = process.env.CODEX_FLEET_AVAILABLE_MODEL_TIERS;
    process.env.CODEX_FLEET_AVAILABLE_MODEL_TIERS = "cheap,standard";
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);
    const client = createClient(paths, "orch", "orchestrator");
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };

    try {
      await expect(
        callDaemon(rpc, "delegate_task", {
          target: { shell: true },
          deliveryMode: "full_delivery",
          risk: "high",
          modelTier: "cheap",
          prompt: "requires strong"
        })
      ).rejects.toThrow('minimum "strong"');
    } finally {
      restoreAvailableModelTiers(previousAvailable);
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function restoreAvailableModelTiers(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.CODEX_FLEET_AVAILABLE_MODEL_TIERS;
  } else {
    process.env.CODEX_FLEET_AVAILABLE_MODEL_TIERS = previous;
  }
}

function restoreAvailableModelRoutes(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.CODEX_FLEET_AVAILABLE_MODEL_ROUTES;
  } else {
    process.env.CODEX_FLEET_AVAILABLE_MODEL_ROUTES = previous;
  }
}
