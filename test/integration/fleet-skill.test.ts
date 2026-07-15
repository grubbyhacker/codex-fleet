import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listTargetsToolDescription } from "../../packages/mcp-adapter/src/index.js";
import { fleetSkillDestinations, installFleetSkill } from "../../scripts/install-fleet-skill.js";

describe("Fleet skill distribution and discovery guidance", () => {
  it("installs one canonical skill for both Codex and Claude", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-fleet-skill-"));
    const source = join(root, "source");
    const destinations = fleetSkillDestinations(
      {
        CODEX_HOME: join(root, "codex-home"),
        CLAUDE_CONFIG_DIR: join(root, "claude-home")
      },
      join(root, "unused-home")
    );
    expect(fleetSkillDestinations({}, join(root, "home"))).toEqual([
      join(root, "home", ".codex", "skills", "use-codex-fleet"),
      join(root, "home", ".claude", "skills", "use-codex-fleet")
    ]);
    try {
      mkdirSync(join(source, "references"), { recursive: true });
      writeFileSync(join(source, "SKILL.md"), "canonical skill\n");
      writeFileSync(join(source, "references", "tool-patterns.md"), "canonical reference\n");
      mkdirSync(destinations[0]!, { recursive: true });
      writeFileSync(join(destinations[0]!, "stale.txt"), "stale\n");

      expect(installFleetSkill({ source, destinations })).toEqual(destinations);
      for (const destination of destinations) {
        expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe("canonical skill\n");
        expect(readFileSync(join(destination, "references", "tool-patterns.md"), "utf8")).toBe(
          "canonical reference\n"
        );
      }
      expect(() => readFileSync(join(destinations[0]!, "stale.txt"))).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("discourages routine list_targets preflights in both the skill and MCP metadata", () => {
    const skill = readFileSync(
      join(process.cwd(), "docs", "skills", "use-codex-fleet", "SKILL.md"),
      "utf8"
    );
    expect(skill).toContain("Do not call `list_targets` as a connection preflight");
    expect(skill).toContain("When the target alias and delivery boundary are already known");

    expect(listTargetsToolDescription).toContain(
      "Do not call as a connection preflight or routine first step"
    );
  });
});
