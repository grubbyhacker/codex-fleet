import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { summarizeCodexRollouts } from "../../packages/tui/src/codex-usage.js";

describe("Codex token usage", () => {
  it("uses timestamped per-call deltas and preserves model switches", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-usage-"));
    const primary = join(root, "primary.jsonl");
    const fallback = join(root, "fallback.jsonl");
    const now = new Date(2026, 6, 15, 12, 0, 0);
    try {
      writeFileSync(
        primary,
        [
          turnContext(new Date(2026, 6, 2, 9), "gpt-5.6-sol"),
          tokenCount(new Date(2026, 6, 2, 9, 1), 300, 250, 200, 50, 10),
          turnContext(new Date(2026, 6, 14, 9), "gpt-5.6-luna"),
          tokenCount(new Date(2026, 6, 14, 9, 1), 200, 180, 150, 20, 5),
          turnContext(new Date(2026, 6, 15, 8), "gpt-5.6-sol"),
          tokenCount(new Date(2026, 6, 15, 8, 1), 100, 90, 80, 10, 2),
          turnContext(new Date(2026, 6, 15, 9), "gpt-5.6-terra"),
          tokenCount(new Date(2026, 6, 15, 9, 1), 50, 40, 20, 10, 1),
          tokenCount(new Date(2026, 6, 15, 9, 2), 25, 0, 0, 0, 0),
          "not-json"
        ].join("\n") + "\n"
      );
      writeFileSync(fallback, `${tokenCount(new Date(2026, 6, 15, 10), 30, 20, 5, 10, 0)}\n`);

      const usage = await summarizeCodexRollouts(
        [
          { fallbackModel: "unknown", path: primary },
          { fallbackModel: "gpt-5.5", path: fallback },
          { fallbackModel: "gpt-5.6-sol", path: join(root, "missing.jsonl") }
        ],
        now
      );

      expect(usage.daily).toEqual({
        cachedInput: 105,
        calls: 4,
        input: 150,
        output: 30,
        reasoningOutput: 3,
        total: 205,
        unclassified: 25,
        uncachedInput: 45
      });
      expect(usage.weekly?.total).toBe(405);
      expect(usage.monthly?.total).toBe(705);
      expect(usage.dailyModels).toEqual([
        { model: "gpt-5.6-sol", total: 100 },
        { model: "gpt-5.6-terra", total: 75 },
        { model: "gpt-5.5", total: 30 }
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function turnContext(timestamp: Date, model: string): string {
  return JSON.stringify({
    timestamp: timestamp.toISOString(),
    type: "turn_context",
    payload: { model }
  });
}

function tokenCount(
  timestamp: Date,
  total: number,
  input: number,
  cachedInput: number,
  output: number,
  reasoningOutput: number
): string {
  return JSON.stringify({
    timestamp: timestamp.toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          cached_input_tokens: cachedInput,
          input_tokens: input,
          output_tokens: output,
          reasoning_output_tokens: reasoningOutput,
          total_tokens: total
        }
      }
    }
  });
}
