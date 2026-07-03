import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const outputs = [
  ["packages/cli/src/index.ts", "codex-fleet"],
  ["packages/daemon/src/index.ts", "codex-fleet-daemon"],
  ["packages/mcp-adapter/src/index.ts", "codex-fleet-mcp"],
  ["packages/tui/src/index.ts", "codex-fleet-tui"]
] as const;

const outDir = join(process.cwd(), "dist", "bin");
rmSync(outDir, { force: true, recursive: true });
mkdirSync(outDir, { recursive: true });

for (const [entrypoint, name] of outputs) {
  const proc = compileEntrypoint(entrypoint, name);
  if (proc.exitCode !== 0) {
    process.stderr.write(proc.stderr?.toString() ?? "");
    process.exit(proc.exitCode);
  }
  process.stdout.write(`built dist/bin/${name}\n`);
}

function compileEntrypoint(entrypoint: string, name: string): ReturnType<typeof Bun.spawnSync> {
  try {
    return Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      "--outfile",
      join(outDir, name),
      entrypoint
    ]);
  } finally {
    chmodSync(entrypoint, 0o644);
  }
}
