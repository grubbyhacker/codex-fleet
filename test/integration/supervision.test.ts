import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { createClient } from "../../packages/daemon/src/rpc/auth.js";
import { callDaemon } from "../../packages/daemon/src/rpc/client.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";
import { EventLog } from "../../packages/daemon/src/store/event-log.js";

describe("supervision and waiting", () => {
  it("marks old running tasks stale and returns event deltas", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-supervision-"));
    const paths = resolveFleetPaths(root);
    const client = createClient(paths, "orch", "orchestrator");
    const old = "2026-06-17T00:00:00.000Z";
    const log = new EventLog(paths.eventsPath);
    log.append({
      taskId: "task-stale",
      seq: 0,
      ts: old,
      type: "task_created",
      summary: JSON.stringify({
        target: { shell: true },
        deliveryMode: "research_only",
        risk: "standard",
        promptPreview: "quiet task",
        ownerSession: { clientId: "orch" },
        createdAt: old
      })
    });
    log.append({
      taskId: "task-stale",
      seq: 1,
      ts: old,
      type: "task_state",
      summary: JSON.stringify({
        state: "running",
        lastActivityAt: old
      })
    });

    const daemon = await startDaemon(paths);
    const rpc = { socketPath: paths.socketPath, clientId: "orch", token: client.token };
    try {
      const listed = (await callDaemon(rpc, "list_tasks", {})) as {
        tasks: Array<{ id: string; state: string }>;
      };
      expect(listed.tasks).toContainEqual(
        expect.objectContaining({ id: "task-stale", state: "stale" })
      );

      const waited = (await callDaemon(rpc, "wait_tasks", {
        taskIds: ["task-stale"],
        sinceEventSeq: 1,
        maxWaitSeconds: 1
      })) as { events: Array<{ type: string; seq: number }>; snapshots: Array<{ state: string }> };
      expect(waited.events).toContainEqual(expect.objectContaining({ type: "task_state" }));
      expect(waited.snapshots[0]?.state).toBe("stale");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});
