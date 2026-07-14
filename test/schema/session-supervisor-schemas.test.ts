import { describe, expect, it } from "vitest";

import {
  AGENTD_PROTOCOL_VERSION,
  agentdEventSchema,
  createSessionSchema,
  sessionStatusSchema
} from "@codex-fleet/session-supervisor";

describe("agentd session-supervisor protocol schemas", () => {
  it("versions strict commands, events, and statuses without carrying provider credentials", () => {
    expect(() =>
      createSessionSchema.parse({
        version: AGENTD_PROTOCOL_VERSION,
        coordinatorBinding: "coordinator",
        authorityBinding: "authority",
        workspace: { workspaceRef: "workspace" },
        token: "provider-secret"
      })
    ).toThrow();
    expect(
      agentdEventSchema.parse({
        version: AGENTD_PROTOCOL_VERSION,
        cursor: 1,
        kind: "turn_enqueued",
        sessionId: "session-1",
        turnId: "turn-1",
        payload: {
          turn: {
            turnId: "turn-1",
            sessionId: "session-1",
            prompt: "work",
            idempotencyKey: "key-1",
            phase: "queued",
            attemptIds: [],
            recoveryFacts: [],
            continuationDepth: 0
          }
        }
      }).cursor
    ).toBe(1);
    expect(
      sessionStatusSchema.parse({
        version: AGENTD_PROTOCOL_VERSION,
        sessionId: "session-1",
        coordinatorBinding: "coordinator",
        authorityBinding: "authority",
        workspace: { workspaceRef: "workspace" },
        phase: "active",
        turnIds: [],
        nextCursor: 2
      }).version
    ).toBe(AGENTD_PROTOCOL_VERSION);
  });
});
