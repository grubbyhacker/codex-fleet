import {
  clientRoleSchema,
  createClient,
  resolveFleetPaths,
  startDaemon
} from "@codex-fleet/daemon";

export function cliProbe(): { ok: true; command: string } {
  return { ok: true, command: "codex-fleet" };
}

if (process.argv.includes("--probe")) {
  console.log(JSON.stringify(cliProbe()));
}

const [command, subcommand, ...args] = process.argv.slice(2);

if (command === "client" && subcommand === "init") {
  const clientId = args[0];
  const roleIndex = args.indexOf("--role");
  const role = roleIndex === -1 ? "orchestrator" : args[roleIndex + 1];
  if (!clientId) {
    throw new Error(
      "Usage: codex-fleet client init <clientId> --role <orchestrator|dashboard|cli>"
    );
  }

  const result = createClient(resolveFleetPaths(), clientId, clientRoleSchema.parse(role));
  console.log(
    JSON.stringify(
      {
        clientId: result.record.clientId,
        role: result.record.role,
        scopes: result.record.scopes,
        tokenPath: `${resolveFleetPaths().clientsDir}/${clientId}/token`
      },
      null,
      2
    )
  );
}

if (command === "daemon" && subcommand === "run") {
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
