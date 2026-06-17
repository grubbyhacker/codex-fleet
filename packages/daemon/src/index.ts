import { taskStateSchema } from "@codex-fleet/shared";

import { resolveFleetPaths } from "./paths.js";
import { startDaemon } from "./rpc/server.js";

export { resolveFleetPaths } from "./paths.js";
export { clientRoleSchema, createClient, readClientToken } from "./rpc/auth.js";
export { callDaemon } from "./rpc/client.js";
export { startDaemon } from "./rpc/server.js";

export function daemonProbe(): { ok: true; knownTaskStates: string[] } {
  return {
    ok: true,
    knownTaskStates: taskStateSchema.options
  };
}

if (import.meta.main) {
  if (process.argv.includes("--probe")) {
    console.log(JSON.stringify(daemonProbe()));
  }

  if (process.argv[2] === "run") {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.error("codex-fleet daemon must not run as root");
      process.exit(1);
    }

    const daemon = await startDaemon(resolveFleetPaths());
    console.error(`codex-fleet daemon listening on ${daemon.socketPath}`);

    const stop = async () => {
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  }
}
