import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
};

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "packages/session-supervisor/package.json"), "utf8")
) as PackageManifest;
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];

if (manifest.name !== "@grubbyhacker/session-supervisor")
  throw new Error("unexpected session-supervisor package name");
if (manifest.private) throw new Error("release package must not be private");
if (JSON.stringify(manifest.files) !== JSON.stringify(["dist", "README.md", "COMPATIBILITY.md"]))
  throw new Error("release package files must be the reviewed compiled surface");
if (!tag) throw new Error("pass the immutable release tag or set GITHUB_REF_NAME");

const expectedTag = `session-supervisor-v${manifest.version}`;
if (tag !== expectedTag) throw new Error(`release tag ${tag} does not match ${expectedTag}`);
if (git(["cat-file", "-t", tag]) !== "tag")
  throw new Error("session-supervisor release tag must be annotated");

const releaseCommit = git(["rev-parse", `${tag}^{commit}`]);
const workflowCommit = process.env.GITHUB_SHA;
if (workflowCommit && releaseCommit !== workflowCommit)
  throw new Error("release workflow commit does not match the annotated tag target");

try {
  execFileSync("git", ["merge-base", "--is-ancestor", releaseCommit, "origin/main"], {
    cwd: root,
    stdio: "ignore"
  });
} catch {
  throw new Error("release tag target must be reachable from reviewed origin/main");
}

process.stdout.write(
  `${JSON.stringify({ package: manifest.name, version: manifest.version, tag, releaseCommit })}\n`
);

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
