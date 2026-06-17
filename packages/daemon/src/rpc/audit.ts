import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type AuditOutcome = "accepted" | "rejected";

export type AuditRecord = {
  ts: string;
  requestId?: string;
  clientId?: string;
  method?: string;
  outcome: AuditOutcome;
  reason?: string;
};

export function appendAuditRecord(path: string, record: Omit<AuditRecord, "ts">): void {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
