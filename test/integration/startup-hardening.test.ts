import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";
import { verifyPeerUid } from "../../packages/daemon/src/rpc/peer-credentials.js";
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

  it("accepts unix socket peers owned by the daemon uid", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-peer-uid-"));
    const socketPath = join(root, "peer.sock");
    let server: net.Server | undefined;

    try {
      const peer = await new Promise<Awaited<ReturnType<typeof verifyPeerUid>>>(
        (resolve, reject) => {
          server = net.createServer((socket) => {
            void verifyPeerUid(socket)
              .then(resolve, reject)
              .finally(() => socket.end());
          });
          server.once("error", reject);
          server.listen(socketPath, () => {
            net.createConnection(socketPath).end();
          });
        }
      );

      expect(peer).toMatchObject({ ok: true, uid: process.getuid?.() });
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      rmSync(root, { force: true, recursive: true });
    }
  });
});
