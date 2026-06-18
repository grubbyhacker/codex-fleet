import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCodexCommand } from "../../packages/daemon/src/workers/codex-backend.js";

describe("codex worker backend", () => {
  it("honors explicit codex command configuration", () => {
    const previous = process.env.CODEX_FLEET_CODEX_COMMAND;
    process.env.CODEX_FLEET_CODEX_COMMAND = "/custom/codex";
    try {
      expect(resolveCodexCommand(["/missing/codex"])).toBe("/custom/codex");
    } finally {
      restoreEnv("CODEX_FLEET_CODEX_COMMAND", previous);
    }
  });

  it("uses the first existing installed command candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-codex-command-"));
    try {
      const candidate = join(root, "Codex.app", "Contents", "Resources", "codex");
      mkdirSync(join(root, "Codex.app", "Contents", "Resources"), { recursive: true });
      writeFileSync(candidate, "#!/bin/sh\n");
      expect(resolveCodexCommand(["/missing/codex", candidate])).toBe(candidate);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("falls back to PATH lookup when no candidate exists", () => {
    const previous = process.env.CODEX_FLEET_CODEX_COMMAND;
    delete process.env.CODEX_FLEET_CODEX_COMMAND;
    try {
      expect(resolveCodexCommand(["/missing/codex"])).toBe("codex");
    } finally {
      restoreEnv("CODEX_FLEET_CODEX_COMMAND", previous);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
