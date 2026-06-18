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
  showAll?: boolean;
  color?: boolean;
};

const terminalStates = new Set<TaskState>(["exited", "failed_to_start", "cancelled", "timed_out"]);
const activeStates = new Set<TaskState>(["queued", "running", "stale"]);
const freshTerminalWindowMs = 30 * 60 * 1_000;
const maxDefaultTerminalRows = 8;

export function tuiProbe(): { ok: true; dashboard: "opentui" } {
  return { ok: true, dashboard: "opentui" };
}

export function renderDashboard(data: DashboardData, options: DashboardOptions = {}): string {
  const lines: string[] = [];
  const now = Date.parse(data.collectedAt);
  const visible = selectVisibleTasks(data.tasks, now, options);
  const selected = selectTask(data.tasks, visible.tasks, options.taskId);
  const summary = summarize(data.tasks);
  const activeCount = data.tasks.filter((task) => activeStates.has(task.state)).length;

  lines.push(style("Codex Fleet", "title", options));
  lines.push(`Updated: ${data.collectedAt} (${formatAge(now, now)})`);
  lines.push(
    [
      activeCount > 0
        ? style(`ACTIVE ${activeCount}`, summary.stale > 0 ? "warn" : "active", options)
        : style("ACTIVE 0", "dim", options),
      `queued ${summary.queued}`,
      `running ${summary.running}`,
      summary.stale > 0
        ? style(`stale ${summary.stale}`, "warn", options)
        : `stale ${summary.stale}`,
      `exited ${summary.exited}`,
      `cleanup-pending ${summary.cleanupPending}`
    ].join(" | ")
  );
  lines.push(
    [
      `tasks ${data.tasks.length}`,
      `visible ${visible.tasks.length}`,
      visible.hiddenTerminal > 0 ? `hidden-old ${visible.hiddenTerminal}` : undefined,
      `repos ${summary.reposTouched}`,
      `median-runtime ${summary.medianRuntime}`,
      `longest-runtime ${summary.longestRuntime}`
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ")
  );
  lines.push("");

  if (visible.active.length > 0) {
    lines.push(style("Active", "section", options));
    for (const task of visible.active) {
      lines.push(formatTaskRow(task, now, options));
    }
  } else {
    lines.push(`${style("Active", "section", options)}  ${style("none", "dim", options)}`);
  }

  if (visible.terminal.length > 0) {
    lines.push("");
    lines.push(style(options.showAll ? "Terminal" : "Fresh Terminal", "section", options));
    for (const task of visible.terminal) {
      lines.push(formatTaskRow(task, now, options));
    }
  }

  if (visible.hiddenTerminal > 0) {
    lines.push("");
    lines.push(
      style(
        `${visible.hiddenTerminal} older terminal task${visible.hiddenTerminal === 1 ? "" : "s"} hidden; use --all to show them.`,
        "dim",
        options
      )
    );
  }

  if (selected) {
    lines.push("");
    lines.push(`Task ${selected.id}`);
    lines.push(`  Target:   ${formatTarget(selected)}`);
    lines.push(`  Session:  ${formatSession(selected)}`);
    lines.push(`  State:    ${stateBadge(selected, options)}`);
    lines.push(
      `  Started:  ${selected.createdAt} (${formatAge(Date.parse(selected.createdAt), now)} ago)`
    );
    lines.push(
      `  Updated:  ${selected.updatedAt} (${formatAge(Date.parse(selected.updatedAt), now)} ago)`
    );
    if (activeStates.has(selected.state)) {
      lines.push(`  Quiet:    ${formatQuiet(selected, now)}`);
    }
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
      text.content = renderDashboard(await loadDashboardData(), {
        ...parseOptions(),
        color: false
      });
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
  return {
    taskId: taskIndex === -1 ? undefined : process.argv[taskIndex + 1],
    showAll: process.argv.includes("--all"),
    color:
      !process.argv.includes("--json") &&
      !process.argv.includes("--no-color") &&
      process.env.NO_COLOR === undefined
  };
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
    reposTouched: repos.size,
    medianRuntime: formatDuration(median(durations)),
    longestRuntime: formatDuration(durations.at(-1))
  };
}

function selectTask(
  allTasks: TaskSnapshot[],
  visibleTasks: TaskSnapshot[],
  taskId?: string
): TaskSnapshot | undefined {
  if (taskId) {
    return allTasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
  }
  return visibleTasks[0];
}

function formatSession(task: TaskSnapshot): string {
  return task.ownerSession.sessionName
    ? `${task.ownerSession.clientId}/${task.ownerSession.sessionName}`
    : task.ownerSession.clientId;
}

function formatTarget(task: TaskSnapshot): string {
  return "repo" in task.target ? `repo ${task.target.repo}` : "shell";
}

function selectVisibleTasks(
  tasks: TaskSnapshot[],
  now: number,
  options: DashboardOptions
): {
  tasks: TaskSnapshot[];
  active: TaskSnapshot[];
  terminal: TaskSnapshot[];
  hiddenTerminal: number;
} {
  const active = tasks
    .filter((task) => activeStates.has(task.state))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const terminal = tasks
    .filter((task) => terminalStates.has(task.state))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const visibleTerminal = options.showAll
    ? terminal
    : terminal
        .filter((task) => now - Date.parse(task.updatedAt) <= freshTerminalWindowMs)
        .slice(0, maxDefaultTerminalRows);
  return {
    tasks: [...active, ...visibleTerminal],
    active,
    terminal: visibleTerminal,
    hiddenTerminal: terminal.length - visibleTerminal.length
  };
}

function formatTaskRow(task: TaskSnapshot, now: number, options: DashboardOptions): string {
  const prefix = activeStates.has(task.state) ? ">>" : "  ";
  const target = formatTarget(task).padEnd(16);
  const state = stateBadge(task, options).padEnd(options.color ? 26 : 16);
  const age = activeStates.has(task.state)
    ? `running ${formatAge(Date.parse(task.createdAt), now)}`
    : `updated ${formatAge(Date.parse(task.updatedAt), now)} ago`;
  const quiet = activeStates.has(task.state) ? `quiet ${formatQuiet(task, now)}` : formatExit(task);
  return [prefix, task.id.slice(0, 8), state, target, formatSession(task), age, quiet]
    .filter(Boolean)
    .join("  ");
}

function stateBadge(task: TaskSnapshot, options: DashboardOptions): string {
  const label = task.state.toUpperCase();
  if (task.state === "running") {
    return style("[RUNNING]", "active", options);
  }
  if (task.state === "queued") {
    return style("[QUEUED]", "info", options);
  }
  if (task.state === "stale") {
    return style("[STALE]", "warn", options);
  }
  if (task.state === "exited") {
    return style("[EXITED]", "ok", options);
  }
  return style(`[${label}]`, "bad", options);
}

function formatExit(task: TaskSnapshot): string {
  if (task.exitCode !== undefined) {
    return `exit ${task.exitCode}`;
  }
  return "";
}

function formatQuiet(task: TaskSnapshot, now: number): string {
  if (!task.lastActivityAt) {
    return "no activity";
  }
  return `${formatAge(Date.parse(task.lastActivityAt), now)} ago`;
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

function formatAge(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) {
    return "n/a";
  }
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function style(
  value: string,
  kind: "active" | "bad" | "dim" | "info" | "ok" | "section" | "title" | "warn",
  options: DashboardOptions
): string {
  if (!options.color) {
    return value;
  }
  const codes = {
    active: "1;32",
    bad: "1;31",
    dim: "2",
    info: "1;36",
    ok: "32",
    section: "1;37",
    title: "1;36",
    warn: "1;33"
  } satisfies Record<typeof kind, string>;
  return `\u001b[${codes[kind]}m${value}\u001b[0m`;
}
