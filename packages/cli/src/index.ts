export function cliProbe(): { ok: true; command: string } {
  return { ok: true, command: "codex-fleet" };
}

if (process.argv.includes("--probe")) {
  console.log(JSON.stringify(cliProbe()));
}
