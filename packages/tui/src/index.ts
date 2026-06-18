import { callDaemon, readClientToken, resolveFleetPaths } from "@codex-fleet/daemon";
import type { Event, TaskSnapshot, TaskState } from "@codex-fleet/shared";
import { createCliRenderer, TextRenderable } from "@opentui/core";

type DashboardData = {
  tasks: TaskSnapshot[];
  histories: Record<string, Event[]>;
  collectedAt: string;
};

type DashboardOptions = {
  taskId?: string;
};

const terminalStates = new Set<TaskState>(["exited", "failed_to_start", "cancelled", "timed_out"]);

export function tuiProbe(): { ok: true; dashboard: "opentui" } {
  return { ok: true, dashboard: "opentui" };
}

export function renderDashboard(data: DashboardData, options: DashboardOptions = {}): string {
  const lines: string[] = [];
  const selected = selectTask(data.tasks, options.taskId);
  const groups = groupBySession(data.tasks);
  const summary = summarize(data.tasks);

  lines.push("Codex Fleet");
  lines.push(`Updated: ${data.collectedAt}`);
  lines.push(
    [
      `queued ${summary.queued}`,
      `running ${summary.running}`,
      `stale ${summary.stale}`,
      `exited ${summary.exited}`,
      `cleanup-pending ${summary.cleanupPending}`
    ].join(" | ")
  );
  lines.push(
    [
      `tasks ${data.tasks.length}`,
      `sessions ${groups.size}`,
      `repos ${summary.reposTouched}`,
      `active-workers ${summary.activeWorkers}`,
      `median-runtime ${summary.medianRuntime}`,
      `longest-runtime ${summary.longestRuntime}`
    ].join(" | ")
  );
  lines.push("");

  for (const [session, tasks] of groups) {
    lines.push(`session: ${session} ${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
    for (const task of tasks) {
      lines.push(
        `  ${task.id.slice(0, 8)}  ${formatTarget(task)}  ${task.state.toUpperCase()}  ${formatActivity(task)}`
      );
    }
  }

  if (selected) {
    lines.push("");
    lines.push(`Task ${selected.id}`);
    lines.push(`  Target:   ${formatTarget(selected)}`);
    lines.push(`  Session:  ${formatSession(selected)}`);
    lines.push(`  State:    ${selected.state}`);
    lines.push(`  Started:  ${selected.createdAt}`);
    lines.push(`  Updated:  ${selected.updatedAt}`);
    if (selected.worktreePath) {
      lines.push(`  Worktree: ${selected.worktreePath}`);
    }
    if (selected.branch) {
      lines.push(`  Branch:   ${selected.branch}`);
    }
    if (selected.exitCode !== undefined) {
      lines.push(`  Exit:     ${selected.exitCode}`);
    }
    if (selected.finalResponsePreview) {
      lines.push(`  Last output: ${oneLine(selected.finalResponsePreview, 100)}`);
    }

    const history = data.histories[selected.id] ?? [];
    if (history.length > 0) {
      lines.push("");
      lines.push("Events");
      for (const event of history.slice(-8)) {
        lines.push(`  ${event.seq} ${event.type} ${oneLine(event.summary, 120)}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  if (process.argv.includes("--probe")) {
    console.log(JSON.stringify(tuiProbe()));
  } else if (process.argv.includes("--once")) {
    const data = await loadDashboardData();
    if (process.argv.includes("--json")) {
      console.log(
        JSON.stringify({ ...data, rendered: renderDashboard(data, parseOptions()) }, null, 2)
      );
    } else {
      process.stdout.write(renderDashboard(data, parseOptions()));
    }
  } else {
    await runDashboard();
  }
}

async function runDashboard(): Promise<void> {
  const renderer = await createCliRenderer({
    clearOnShutdown: true,
    exitOnCtrlC: true,
    targetFps: 2
  });
  const text = new TextRenderable(renderer, {
    content: "Codex Fleet\nLoading...\n",
    width: "100%",
    height: "100%",
    wrapMode: "none"
  });
  renderer.root.add(text);
  renderer.start();

  const refresh = async () => {
    try {
      text.content = renderDashboard(await loadDashboardData(), parseOptions());
    } catch (error) {
      text.content = `Codex Fleet\n${error instanceof Error ? error.message : String(error)}\n`;
    }
  };

  await refresh();
  const timer = setInterval(() => void refresh(), 1_000);
  renderer.on("destroy", () => clearInterval(timer));
}

async function loadDashboardData(): Promise<DashboardData> {
  const rpc = loadRpcOptions();
  const listed = (await callDaemon(rpc, "list_tasks", {})) as { tasks: TaskSnapshot[] };
  const histories: Record<string, Event[]> = {};
  await Promise.all(
    listed.tasks.map(async (task) => {
      const result = (await callDaemon(rpc, "get_task_history", {
        taskId: task.id,
        limit: 8
      })) as { events: Event[] };
      histories[task.id] = result.events;
    })
  );
  return { tasks: listed.tasks, histories, collectedAt: new Date().toISOString() };
}

function loadRpcOptions(): { socketPath: string; clientId: string; token: string } {
  const paths = resolveFleetPaths();
  const clientId = process.env.CODEX_FLEET_CLIENT_ID ?? "dashboard";
  return {
    socketPath: paths.socketPath,
    clientId,
    token: process.env.CODEX_FLEET_TOKEN ?? readClientToken(paths, clientId)
  };
}

function parseOptions(): DashboardOptions {
  const taskIndex = process.argv.indexOf("--task");
  return { taskId: taskIndex === -1 ? undefined : process.argv[taskIndex + 1] };
}

function summarize(tasks: TaskSnapshot[]) {
  const counts = new Map<TaskState, number>();
  const repos = new Set<string>();
  const durations = tasks
    .filter((task) => terminalStates.has(task.state))
    .map((task) => Date.parse(task.updatedAt) - Date.parse(task.createdAt))
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .sort((left, right) => left - right);

  for (const task of tasks) {
    counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
    if ("repo" in task.target) {
      repos.add(task.target.repo);
    }
  }

  return {
    queued: counts.get("queued") ?? 0,
    running: counts.get("running") ?? 0,
    stale: counts.get("stale") ?? 0,
    exited: counts.get("exited") ?? 0,
    cleanupPending: tasks.filter((task) => terminalStates.has(task.state) && task.worktreePath)
      .length,
    activeWorkers: tasks.filter((task) => task.state === "running" || task.state === "stale")
      .length,
    reposTouched: repos.size,
    medianRuntime: formatDuration(median(durations)),
    longestRuntime: formatDuration(durations.at(-1))
  };
}

function groupBySession(tasks: TaskSnapshot[]): Map<string, TaskSnapshot[]> {
  const groups = new Map<string, TaskSnapshot[]>();
  for (const task of tasks) {
    const session = formatSession(task);
    groups.set(session, [...(groups.get(session) ?? []), task]);
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function selectTask(tasks: TaskSnapshot[], taskId?: string): TaskSnapshot | undefined {
  if (taskId) {
    return tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
  }
  return tasks[0];
}

function formatSession(task: TaskSnapshot): string {
  return task.ownerSession.sessionName
    ? `${task.ownerSession.clientId}/${task.ownerSession.sessionName}`
    : task.ownerSession.clientId;
}

function formatTarget(task: TaskSnapshot): string {
  return "repo" in task.target ? `repo ${task.target.repo}` : "shell";
}

function formatActivity(task: TaskSnapshot): string {
  const pieces = [`updated ${task.updatedAt}`];
  if (task.lastActivityAt) {
    pieces.push(`activity ${task.lastActivityAt}`);
  }
  if (task.exitCode !== undefined) {
    pieces.push(`exit ${task.exitCode}`);
  }
  return pieces.join(" · ");
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values[Math.floor(values.length / 2)];
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  return `${Math.round(ms / 1_000)}s`;
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}
