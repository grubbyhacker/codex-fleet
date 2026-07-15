import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const skillName = "use-codex-fleet";

export function fleetSkillDestinations(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  const codexHome = environment.CODEX_HOME ?? join(home, ".codex");
  const claudeHome = environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return [
    ...new Set([join(codexHome, "skills", skillName), join(claudeHome, "skills", skillName)])
  ];
}

export function installFleetSkill(options: { source: string; destinations: string[] }): string[] {
  if (!existsSync(options.source)) {
    throw new Error(`Fleet skill source not found: ${options.source}`);
  }
  for (const destination of options.destinations) {
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { force: true, recursive: true });
    cpSync(options.source, destination, { recursive: true });
  }
  return options.destinations;
}

if (import.meta.main) {
  const destinations = installFleetSkill({
    source: join(process.cwd(), "docs", "skills", skillName),
    destinations: fleetSkillDestinations()
  });
  for (const destination of destinations) {
    process.stdout.write(`installed Fleet skill to ${destination}\n`);
  }
}
