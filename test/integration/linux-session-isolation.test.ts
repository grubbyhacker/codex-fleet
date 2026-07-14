import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const runnable = process.platform === "linux" && process.getuid?.() === 0;

describe.skipIf(!runnable)("Linux test-only per-session UID/GID isolation proof", () => {
  it("denies a different session identity read, write, and traversal into a 0700 workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "agentd-uid-proof-"));
    const firstUid = 41_001;
    const secondUid = 41_002;
    const first = join(root, "session-first");
    const second = join(root, "session-second");
    try {
      mkdirSync(first);
      mkdirSync(second);
      chmodSync(root, 0o755);
      chownSync(first, firstUid, firstUid);
      chownSync(second, secondUid, secondUid);
      chmodSync(first, 0o700);
      chmodSync(second, 0o700);
      const secret = join(first, "secret");
      writeFileSync(secret, "first session only\n", { mode: 0o600 });
      chownSync(secret, firstUid, firstUid);
      const asSession = (uid: number, expression: string) =>
        spawnSync("/usr/bin/setpriv", [
          "--reuid",
          String(uid),
          "--regid",
          String(uid),
          "--clear-groups",
          "--",
          "/bin/sh",
          "-c",
          expression,
          "sh",
          secret
        ]);
      const own = asSession(firstUid, 'test -r "$1"');
      const crossRead = asSession(secondUid, 'test ! -r "$1"');
      const crossWrite = asSession(secondUid, 'test ! -w "$1"');
      const crossTraverse = asSession(secondUid, 'test ! -x "$(dirname "$1")"');
      expect(own.status).toBe(0);
      expect(crossRead.status).toBe(0);
      expect(crossWrite.status).toBe(0);
      expect(crossTraverse.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
