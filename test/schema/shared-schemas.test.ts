import { describe, expect, it } from "vitest";

import { delegateTaskRequestSchema, waitTasksRequestSchema } from "@codex-fleet/shared";

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
});
