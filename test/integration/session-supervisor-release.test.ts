import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("session supervisor release workflow", () => {
  test("fetches the annotated tag object before release verification", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../.github/workflows/session-supervisor-release.yml"),
      "utf8"
    );
    const fetchTag = workflow.indexOf(
      'git fetch --force origin "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"'
    );
    const verifyRelease = workflow.indexOf("bun run verify:session-supervisor-release", fetchTag);

    expect(fetchTag).toBeGreaterThan(-1);
    expect(verifyRelease).toBeGreaterThan(fetchTag);
  });

  test("passes the GitHub package token through Bun's supported variable", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../.github/workflows/session-supervisor-release.yml"),
      "utf8"
    );

    expect(workflow).toContain("NPM_CONFIG_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");
  });
});
