import {
  callDaemon,
  clientRoleSchema,
  createClient,
  readClientToken,
  resolveFleetPaths,
  startDaemon
} from "@codex-fleet/daemon";

export function cliProbe(): { ok: true; command: string } {
  return { ok: true, command: "codex-fleet" };
}

if (import.meta.main) {
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

  if (command === "list") {
    console.log(JSON.stringify(await callDaemon(loadRpcOptions(), "list_tasks", {}), null, 2));
  }

  if (command === "status") {
    const taskId = subcommand;
    if (!taskId) {
      throw new Error("Usage: codex-fleet status <taskId>");
    }
    console.log(
      JSON.stringify(await callDaemon(loadRpcOptions(), "get_task", { taskId }), null, 2)
    );
  }

  if (command === "logs") {
    const taskId = subcommand;
    if (!taskId) {
      throw new Error("Usage: codex-fleet logs <taskId>");
    }
    console.log(
      JSON.stringify(await callDaemon(loadRpcOptions(), "get_task_history", { taskId }), null, 2)
    );
  }

  if (command === "watch") {
    const taskId = subcommand;
    if (!taskId) {
      throw new Error("Usage: codex-fleet watch <taskId>");
    }
    console.log(
      JSON.stringify(
        await callDaemon(loadRpcOptions(), "wait_tasks", {
          taskIds: [taskId],
          maxWaitSeconds: Number(process.env.CODEX_FLEET_WATCH_SECONDS ?? "5")
        }),
        null,
        2
      )
    );
  }
}

function loadRpcOptions(): { socketPath: string; clientId: string; token: string } {
  const paths = resolveFleetPaths();
  const clientId = process.env.CODEX_FLEET_CLIENT_ID ?? "cli";
  return {
    socketPath: paths.socketPath,
    clientId,
    token: process.env.CODEX_FLEET_TOKEN ?? readClientToken(paths, clientId)
  };
}
