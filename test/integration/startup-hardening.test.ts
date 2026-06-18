import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { startDaemon } from "../../packages/daemon/src/rpc/server.js";

describe("daemon startup hardening", () => {
  it("refuses to replace an active daemon socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-active-socket-"));
    const paths = resolveFleetPaths(root);
    const daemon = await startDaemon(paths);

    try {
      await expect(startDaemon(paths)).rejects.toThrow("already active");
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("repairs state dir permissions and removes stale socket leftovers", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-stale-socket-"));
    const paths = resolveFleetPaths(root);
    writeFileSync(paths.socketPath, "stale\n");

    const daemon = await startDaemon(paths);
    try {
      expect(statSync(paths.rootDir).mode & 0o777).toBe(0o700);
      expect(statSync(paths.reposDir).mode & 0o777).toBe(0o700);
      expect(statSync(paths.shellDir).mode & 0o777).toBe(0o700);
      expect(existsSync(paths.socketPath)).toBe(true);
    } finally {
      await daemon.close().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    }
  });
});
