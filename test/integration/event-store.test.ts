import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog } from "../../packages/daemon/src/store/event-log.js";
import { FleetState } from "../../packages/daemon/src/store/state.js";

describe("event log and replay", () => {
  it("appends events and replays current task state", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-events-"));
    try {
      const log = new EventLog(join(root, "tasks", "events.jsonl"));
      log.append({
        taskId: "task-1",
        seq: 0,
        ts: "2026-06-17T00:00:00.000Z",
        type: "task_created",
        summary: JSON.stringify({
          target: { shell: true },
          deliveryMode: "research_only",
          risk: "standard",
          promptPreview: "hello",
          ownerSession: { clientId: "client-1" },
          createdAt: "2026-06-17T00:00:00.000Z"
        })
      });
      log.append({
        taskId: "task-1",
        seq: 1,
        ts: "2026-06-17T00:00:01.000Z",
        type: "task_state",
        summary: JSON.stringify({
          state: "exited",
          exitCode: 0,
          finalResponsePreview: "done"
        })
      });

      const state = FleetState.replay(log.readAll());
      expect(state.getTask("task-1")).toMatchObject({
        id: "task-1",
        state: "exited",
        exitCode: 0,
        finalResponsePreview: "done"
      });
      expect(state.eventsSince(0, ["task-1"]).map((event) => event.seq)).toEqual([1]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
