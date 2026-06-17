import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createClient, hashToken, scopesForRole } from "../../packages/daemon/src/rpc/auth.js";
import { appendAuditRecord } from "../../packages/daemon/src/rpc/audit.js";
import { resolveFleetPaths } from "../../packages/daemon/src/paths.js";

describe("auth and audit", () => {
  it("creates scoped clients without storing plaintext tokens in metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-auth-"));
    try {
      const paths = resolveFleetPaths(root);
      const { token, record } = createClient(paths, "orchestrator-test", "orchestrator");

      expect(record.scopes).toEqual(scopesForRole("orchestrator"));
      expect(record.tokenHash).toBe(hashToken(token));
      expect(
        readFileSync(`${paths.clientsDir}/orchestrator-test/client.json`, "utf8")
      ).not.toContain(token);
      expect(readFileSync(`${paths.clientsDir}/orchestrator-test/token`, "utf8")).toContain(token);
      expect(statSync(paths.rootDir).mode & 0o777).toBe(0o700);
      expect(statSync(`${paths.clientsDir}/orchestrator-test/token`).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("writes audit records as jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-audit-"));
    try {
      const auditPath = join(root, "audit.jsonl");
      appendAuditRecord(auditPath, {
        requestId: "req-1",
        clientId: "client-1",
        method: "list_targets",
        outcome: "accepted"
      });

      const [line] = readFileSync(auditPath, "utf8").trim().split("\n");
      expect(JSON.parse(line ?? "{}")).toMatchObject({
        requestId: "req-1",
        clientId: "client-1",
        method: "list_targets",
        outcome: "accepted"
      });
      expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
