import { taskStateSchema } from "@codex-fleet/shared";

export function daemonProbe(): { ok: true; knownTaskStates: string[] } {
  return {
    ok: true,
    knownTaskStates: taskStateSchema.options
  };
}

if (process.argv.includes("--probe")) {
  console.log(JSON.stringify(daemonProbe()));
}
