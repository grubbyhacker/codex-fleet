import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";

import { eventSchema, type Event } from "@codex-fleet/shared";

export class EventLog {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(event: Event): void {
    mkdirSync(dirname(this.path), { mode: 0o700, recursive: true });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readAll(): Event[] {
    if (!existsSync(this.path)) {
      return [];
    }

    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => eventSchema.parse(JSON.parse(line)));
  }
}
