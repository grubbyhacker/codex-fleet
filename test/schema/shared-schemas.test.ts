import { describe, expect, it } from "vitest";

import {
  daemonErrorResponseSchema,
  delegateTaskRequestSchema,
  methodParamsSchemas,
  rpcEnvelopeSchema,
  waitTasksRequestSchema
} from "@codex-fleet/shared";

describe("shared schemas", () => {
  it("accepts the minimal delegate task request", () => {
    const parsed = delegateTaskRequestSchema.parse({
      target: { repo: "codex-fleet" },
      deliveryMode: "patch",
      prompt: "Implement a small change"
    });

    expect(parsed.risk).toBe("standard");
  });

  it("caps wait intervals to the design bound", () => {
    expect(() =>
      waitTasksRequestSchema.parse({
        taskIds: ["task-1"],
        maxWaitSeconds: 60
      })
    ).toThrow();
  });

  it("requires authenticated daemon RPC envelopes with known methods", () => {
    const parsed = rpcEnvelopeSchema.parse({
      requestId: "req-1",
      clientId: "client-1",
      token: "secret",
      method: "delegate_task",
      params: {
        target: { shell: true },
        deliveryMode: "research_only",
        prompt: "Inspect the host"
      }
    });

    expect(parsed.method).toBe("delegate_task");
  });

  it("keeps teaching errors in the public response shape", () => {
    const parsed = daemonErrorResponseSchema.parse({
      requestId: "req-1",
      ok: false,
      error: {
        code: "not_found",
        message: "Unknown task",
        nextCall: "list_tasks"
      }
    });

    expect(parsed.error.nextCall).toBe("list_tasks");
  });

  it("has params schemas for every public daemon method", () => {
    expect(Object.keys(methodParamsSchemas).sort()).toEqual([
      "delegate_task",
      "end_task",
      "get_task",
      "get_task_history",
      "initialize",
      "list_targets",
      "list_tasks",
      "wait_tasks"
    ]);
  });
});
