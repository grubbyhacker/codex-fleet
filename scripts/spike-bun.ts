import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import net from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

const results: CheckResult[] = [];

async function check(name: string, run: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
  }
}

await check("bun runtime", () => {
  return `Bun ${Bun.version}`;
});

await check("mcp sdk import", () => {
  const server = new McpServer({ name: "codex-fleet-spike", version: "0.0.0" });
  return `created ${server.constructor.name}`;
});

await check("zod validation", () => {
  const parsed = z.object({ ok: z.literal(true) }).parse({ ok: true });
  return JSON.stringify(parsed);
});

await check("subprocess supervision", async () => {
  const child = Bun.spawn([process.execPath, "--version"], {
    stderr: "pipe",
    stdout: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`process exited ${exitCode}: ${stderr.trim()}`);
  }
  return stdout.trim();
});

await check("unix socket rpc", async () => {
  const dir = join(tmpdir(), `codex-fleet-spike-${randomUUID()}`);
  const socketPath = join(dir, "daemon.sock");
  mkdirSync(dir, { recursive: true });

  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(`ack:${chunk.toString()}`);
      socket.end();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const response = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(socketPath);
      let data = "";
      client.setEncoding("utf8");
      client.on("connect", () => client.write("ping"));
      client.on("data", (chunk) => {
        data += chunk;
      });
      client.on("end", () => resolve(data));
      client.on("error", reject);
    });

    if (response !== "ack:ping") {
      throw new Error(`unexpected response ${response}`);
    }
    return socketPath;
  } finally {
    server.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

await check("append-only jsonl fsync", () => {
  const path = join(tmpdir(), `codex-fleet-${randomUUID()}`, "events.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify({ seq: 1, type: "spike" })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const content = readFileSync(path, "utf8");
  rmSync(dirname(path), { force: true, recursive: true });
  if (!content.includes('"spike"')) {
    throw new Error("jsonl record missing after fsync");
  }
  return "record persisted and read back";
});

await check("adapter probe startup", async () => {
  const child = Bun.spawn(
    [process.execPath, "run", "packages/mcp-adapter/src/index.ts", "--probe"],
    {
      stderr: "pipe",
      stdout: "pipe"
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`adapter probe exited ${exitCode}: ${stderr.trim()}`);
  }
  const parsed = z.object({ ok: z.literal(true), server: z.string() }).parse(JSON.parse(stdout));
  return `adapter returned ${parsed.server}`;
});

for (const result of results) {
  const mark = result.ok ? "PASS" : "FAIL";
  console.log(`${mark} ${result.name}: ${result.detail}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  process.exitCode = 1;
}

if (!existsSync("mise.toml")) {
  console.warn("WARN mise.toml was not found; Bun should be pinned through mise.");
}
