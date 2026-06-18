import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const gitCandidates = [
  process.env.CODEX_FLEET_GIT_PATH,
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
  "/usr/bin/git",
  "/bin/git",
  "git"
].filter((candidate): candidate is string => Boolean(candidate));

let cachedGitPath: string | undefined;

export function resolveGitExecutable(): string {
  if (cachedGitPath) {
    return cachedGitPath;
  }
  for (const candidate of gitCandidates) {
    if (candidate.includes("/") && !existsSync(candidate)) {
      continue;
    }
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      cachedGitPath = candidate;
      return candidate;
    } catch {
      continue;
    }
  }
  return "git";
}
