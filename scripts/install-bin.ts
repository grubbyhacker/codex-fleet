import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const names = ["codex-fleet", "codex-fleet-daemon", "codex-fleet-mcp", "codex-fleet-tui"];
const sourceDir = join(process.cwd(), "dist", "bin");
const installDir = process.env.CODEX_FLEET_INSTALL_BIN_DIR ?? join(homedir(), ".local", "bin");

mkdirSync(installDir, { recursive: true });

for (const name of names) {
  const destination = join(installDir, name);
  copyFileSync(join(sourceDir, name), destination);
  chmodSync(destination, 0o755);
  process.stdout.write(`installed ${destination}\n`);
}
