import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const source = join(process.cwd(), "docs", "skills", "use-codex-fleet");
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const destination = join(codexHome, "skills", "use-codex-fleet");

if (!existsSync(source)) {
  throw new Error(`Fleet skill source not found: ${source}`);
}

mkdirSync(join(codexHome, "skills"), { recursive: true });
rmSync(destination, { force: true, recursive: true });
cpSync(source, destination, { recursive: true });
process.stdout.write(`installed Fleet skill to ${destination}\n`);
