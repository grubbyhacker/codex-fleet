import { callDaemon, readClientToken, resolveFleetPaths } from "@codex-fleet/daemon";
import type { Event, TaskSnapshot, TaskState } from "@codex-fleet/shared";
import {
  createCliRenderer,
  RGBA,
  StyledText,
  TextAttributes,
  TextRenderable,
  type TextChunk
} from "@opentui/core";
import { existsSync } from "node:fs";

type DashboardData = {
  tasks: TaskSnapshot[];
  histories: Record<string, Event[]>;
  collectedAt: string;
};

type DashboardOptions = {
  taskId?: string;
  showAll?: boolean;
  color?: boolean;
  mode?: DashboardMode;
  width?: number;
  height?: number;
};

type DashboardMode = "overview" | "prompt" | "result" | "stderr";

type DashboardView = {
  headerLines: string[];
  taskLines: string[];
  detailLines: string[];
  eventLines: string[];
};

const terminalStates = new Set<TaskState>(["exited", "failed_to_start", "cancelled", "timed_out"]);
const liveStates = new Set<TaskState>(["queued", "running"]);
const freshTerminalWindowMs = 30 * 60 * 1_000;
const freshStaleWindowMs = 10 * 60 * 1_000;
const maxDefaultTerminalRows = 8;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const dashboardModes = [
  "overview",
  "prompt",
  "result",
  "stderr"
] as const satisfies readonly DashboardMode[];

export function tuiProbe(): { ok: true; dashboard: "opentui" } {
  return { ok: true, dashboard: "opentui" };
}

export function renderDashboard(data: DashboardData, options: DashboardOptions = {}): string {
  const view = buildDashboardView(data, options);
  const width = options.width ?? 120;
  return finalizeDashboardFrame(renderDashboardLayout(view, width, options), width, options);
}

function buildDashboardView(data: DashboardData, options: DashboardOptions): DashboardView {
  const headerLines: string[] = [];
  const taskLines: string[] = [];
  const detailLines: string[] = [];
  const eventLines: string[] = [];
  const now = Date.parse(data.collectedAt);
  const visible = selectVisibleTasks(data.tasks, now, options);
  const selected = selectTask(data.tasks, visible.tasks, options.taskId);
  const summary = summarize(data.tasks);
  const liveCount = summary.queued + summary.running;
  const mode = options.mode ?? "overview";

  headerLines.push(style("Codex Fleet", "title", options));
  headerLines.push(
    [
      `Updated: ${data.collectedAt} (${formatAge(now, now)})`,
      `mode ${style(mode, "info", options)}`,
      selected ? `selected ${selected.id.slice(0, 8)}` : undefined
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ")
  );
  headerLines.push(
    [
      liveCount > 0
        ? style(`LIVE ${liveCount}`, "active", options)
        : style("LIVE 0", "dim", options),
      summary.needsAttention > 0
        ? style(`attention ${summary.needsAttention}`, "warn", options)
        : `attention ${summary.needsAttention}`,
      `queued ${summary.queued}`,
      `running ${summary.running}`,
      summary.stale > 0
        ? style(`stale ${summary.stale}`, visible.stale.length > 0 ? "warn" : "dim", options)
        : `stale ${summary.stale}`,
      `exited ${summary.exited}`,
      `cleanup-pending ${summary.cleanupPending}`
    ].join(" | ")
  );
  headerLines.push(
    [
      `tasks ${data.tasks.length}`,
      `visible ${visible.tasks.length}`,
      visible.hiddenTerminal + visible.hiddenStale > 0
        ? `hidden-old ${visible.hiddenTerminal + visible.hiddenStale}`
        : undefined,
      `repos ${summary.reposTouched}`,
      `median-runtime ${summary.medianRuntime}`,
      `longest-runtime ${summary.longestRuntime}`
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ")
  );

  if (visible.live.length > 0) {
    taskLines.push(style("Live", "section", options));
    for (const task of visible.live) {
      taskLines.push(formatTaskRow(task, now, options));
    }
  } else {
    taskLines.push(`${style("Live", "section", options)}  ${style("none", "dim", options)}`);
  }

  if (visible.needsAttention.length > 0) {
    taskLines.push("");
    taskLines.push(style("Action Queue", "warn", options));
    for (const task of visible.needsAttention) {
      taskLines.push(formatTaskRow(task, now, options));
      for (const action of attentionActions(task)) {
        taskLines.push(`    ${style(action, "dim", options)}`);
      }
    }
  }

  if (visible.stale.length > 0) {
    taskLines.push("");
    taskLines.push(style("Stale", "warn", options));
    for (const task of visible.stale) {
      taskLines.push(formatTaskRow(task, now, options));
    }
  }

  if (visible.terminal.length > 0) {
    taskLines.push("");
    taskLines.push(
      style(options.showAll ? "Terminal History" : "Recent Results", "section", options)
    );
    for (const task of visible.terminal) {
      taskLines.push(formatTaskRow(task, now, options));
    }
  }

  if (visible.hiddenTerminal + visible.hiddenStale > 0) {
    taskLines.push("");
    const hidden = visible.hiddenTerminal + visible.hiddenStale;
    taskLines.push(
      style(
        `${hidden} older task${hidden === 1 ? "" : "s"} hidden; use --all to show them.`,
        "dim",
        options
      )
    );
  }

  if (selected) {
    detailLines.push(style("Selected Task", "section", options));
    detailLines.push(`Task ${selected.id}`);
    detailLines.push(`Target:   ${formatTarget(selected)}`);
    detailLines.push(`Session:  ${formatSession(selected)}`);
    detailLines.push(`State:    ${stateBadge(selected, options)}`);
    detailLines.push(
      `Started:  ${selected.createdAt} (${formatAge(Date.parse(selected.createdAt), now)} ago)`
    );
    detailLines.push(
      `Updated:  ${selected.updatedAt} (${formatAge(Date.parse(selected.updatedAt), now)} ago)`
    );
    if (liveStates.has(selected.state) || selected.state === "stale") {
      detailLines.push(`Activity: quiet ${formatQuiet(selected, now)}`);
    }
    if (terminalStates.has(selected.state)) {
      const status = formatTerminalStatus(selected);
      if (status) {
        detailLines.push(`Status:   ${status}`);
      }
    }
    detailLines.push(...selectedModeLines(selected, mode, options));
    if (needsAttention(selected)) {
      detailLines.push("");
      detailLines.push(style("Actions", "warn", options));
      for (const action of attentionActions(selected)) {
        detailLines.push(`  ${action}`);
      }
    }
    if (selected.worktreePath) {
      detailLines.push(`Worktree: ${selected.worktreePath}`);
    }
    if (selected.shellPath) {
      detailLines.push(`Shell cwd: ${selected.shellPath}`);
    }
    if (selected.branch) {
      detailLines.push(`Branch:   ${selected.branch}`);
    }
    if (selected.exitCode !== undefined) {
      detailLines.push(`Exit:     ${selected.exitCode}`);
    }

    const history = data.histories[selected.id] ?? [];
    if (history.length > 0) {
      for (const event of history.slice(-24)) {
        eventLines.push(formatEventRow(event, options));
      }
    } else {
      eventLines.push(style("No events for selected task.", "dim", options));
    }
  } else {
    detailLines.push(style("Selected Task", "section", options));
    detailLines.push(style("No visible task selected.", "dim", options));
    eventLines.push(style("No selected task.", "dim", options));
  }

  return { headerLines, taskLines, detailLines, eventLines };
}

if (import.meta.main) {
  if (process.argv.includes("--probe")) {
    console.log(JSON.stringify(tuiProbe()));
  } else if (process.argv.includes("--once")) {
    const data = await loadDashboardData(parseOptions());
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

  let mode = parseOptions().mode ?? "overview";
  const refresh = async () => {
    try {
      const options = { ...parseOptions(), mode };
      text.content = renderDashboardForOpenTui(await loadDashboardData(options), options);
    } catch (error) {
      const options = parseOptions();
      const width = options.width ?? 120;
      const rendered = finalizeDashboardFrame(
        `Codex Fleet\n${error instanceof Error ? error.message : String(error)}`,
        width,
        options
      );
      text.content = options.color ? ansiToStyledText(rendered) : rendered;
    }
  };

  renderer.on("key", (data: Buffer) => {
    const key = data.toString("utf8");
    if (key === "o") {
      mode = "overview";
    } else if (key === "p") {
      mode = "prompt";
    } else if (key === "r") {
      mode = "result";
    } else if (key === "s") {
      mode = "stderr";
    } else if (key === "\t") {
      mode = nextMode(mode);
    } else {
      return;
    }
    void refresh();
  });

  await refresh();
  const timer = setInterval(() => void refresh(), 1_000);
  renderer.on("destroy", () => clearInterval(timer));
}

function renderDashboardForOpenTui(
  data: DashboardData,
  options: DashboardOptions
): string | StyledText {
  const rendered = renderDashboard(data, options);
  return options.color ? ansiToStyledText(rendered) : rendered;
}

async function loadDashboardData(options: DashboardOptions = {}): Promise<DashboardData> {
  const rpc = loadRpcOptions();
  const listed = (await callDaemon(rpc, "list_tasks", {})) as { tasks: TaskSnapshot[] };
  let tasks = listed.tasks;
  const histories: Record<string, Event[]> = {};
  const collectedAt = new Date().toISOString();
  const selected = selectTask(
    tasks,
    selectVisibleTasks(tasks, Date.parse(collectedAt), options).tasks,
    options.taskId
  );
  if (selected) {
    const detailed = (await callDaemon(rpc, "get_task", { taskId: selected.id })) as {
      task: TaskSnapshot;
    };
    tasks = tasks.map((task) => (task.id === selected.id ? detailed.task : task));
    const result = (await callDaemon(rpc, "get_task_history", {
      taskId: selected.id,
      limit: 24
    })) as { events: Event[] };
    histories[selected.id] = result.events;
  }
  return { tasks, histories, collectedAt };
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
  const modeIndex = process.argv.indexOf("--mode");
  return {
    taskId: taskIndex === -1 ? undefined : process.argv[taskIndex + 1],
    showAll: process.argv.includes("--all"),
    color:
      !process.argv.includes("--json") &&
      !process.argv.includes("--no-color") &&
      (process.argv.includes("--color") || process.env.NO_COLOR === undefined),
    mode: modeIndex === -1 ? undefined : parseDashboardMode(process.argv[modeIndex + 1] ?? ""),
    width: process.stdout.columns ?? parseTerminalDimension(process.env.COLUMNS),
    height: process.stdout.rows ?? parseTerminalDimension(process.env.LINES)
  };
}

function parseDashboardMode(value: string): DashboardMode | undefined {
  return dashboardModes.find((mode) => mode === value);
}

function nextMode(current: DashboardMode): DashboardMode {
  const index = dashboardModes.indexOf(current);
  return dashboardModes[(index + 1) % dashboardModes.length] ?? "overview";
}

function parseTerminalDimension(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function renderDashboardLayout(
  view: DashboardView,
  width: number,
  options: DashboardOptions
): string {
  if (width >= 104) {
    return renderWideDashboard(view, width, options);
  }
  return renderStackedDashboard(view, width, options);
}

function renderWideDashboard(
  view: DashboardView,
  width: number,
  options: DashboardOptions
): string {
  const gap = 2;
  const leftWidth = clampNumber(Math.floor(width * 0.36), 44, 62);
  const rightWidth = width - leftWidth - gap;
  const header = renderHeader(view.headerLines, width);
  const headerHeight = header.length + 1;
  const mainBoxHeight =
    options.height !== undefined
      ? clampNumber(
          Math.max(view.taskLines.length, view.detailLines.length) + 2,
          8,
          Math.min(22, Math.max(8, Math.max(0, options.height - headerHeight) - 6))
        )
      : undefined;
  const eventBoxHeight =
    options.height !== undefined && mainBoxHeight !== undefined
      ? Math.max(4, Math.max(0, options.height - headerHeight) - mainBoxHeight)
      : undefined;
  const mainInnerLines = mainBoxHeight ? Math.max(1, mainBoxHeight - 2) : undefined;
  const eventInnerLines = eventBoxHeight ? Math.max(1, eventBoxHeight - 2) : undefined;

  const tasksBox = renderBox("Tasks", view.taskLines, leftWidth, options, mainInnerLines);
  const selectedBox = renderBox("Selected", view.detailLines, rightWidth, options, mainInnerLines);
  const eventsBox = renderBox("Events", view.eventLines, width, options, eventInnerLines);

  return [
    ...header,
    "",
    ...combineColumns(tasksBox, selectedBox, leftWidth, rightWidth, gap),
    ...eventsBox
  ].join("\n");
}

function renderStackedDashboard(
  view: DashboardView,
  width: number,
  options: DashboardOptions
): string {
  const header = renderHeader(view.headerLines, width);
  const boxes = [
    renderBox("Tasks", view.taskLines, width, options),
    renderBox("Selected", view.detailLines, width, options),
    renderBox("Events", view.eventLines, width, options)
  ];
  return [...header, "", ...boxes.flatMap((box, index) => (index === 0 ? box : ["", ...box]))].join(
    "\n"
  );
}

function finalizeDashboardFrame(
  rendered: string,
  width: number,
  options: DashboardOptions
): string {
  const lines = rendered.split("\n").map((line) => fitLine(line, width));
  if (!options.height) {
    return `${lines.join("\n")}\n`;
  }

  const frame = lines.slice(0, options.height);
  while (frame.length < options.height) {
    frame.push(" ".repeat(width));
  }
  return frame.join("\n");
}

function ansiToStyledText(value: string): StyledText {
  const chunks: TextChunk[] = [];
  const pattern = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, "g");
  let cursor = 0;
  let current: NativeTextStyle = {};
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) {
      chunks.push(textChunk(value.slice(cursor, match.index), current));
    }
    current = nativeStyleFromAnsi(match[1] ?? "", current);
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    chunks.push(textChunk(value.slice(cursor), current));
  }
  return new StyledText(chunks);
}

type NativeTextStyle = {
  fg?: RGBA;
  attributes?: number;
};

function textChunk(text: string, textStyle: NativeTextStyle): TextChunk {
  return {
    __isChunk: true,
    text,
    ...(textStyle.fg ? { fg: textStyle.fg } : {}),
    ...(textStyle.attributes ? { attributes: textStyle.attributes } : {})
  };
}

function nativeStyleFromAnsi(value: string, current: NativeTextStyle): NativeTextStyle {
  const codes =
    value.length === 0 ? [0] : value.split(";").map((code) => Number.parseInt(code, 10));
  let next = { ...current };
  for (const code of codes) {
    if (code === 0 || !Number.isFinite(code)) {
      next = {};
    } else if (code === 1) {
      next.attributes = (next.attributes ?? 0) | TextAttributes.BOLD;
    } else if (code === 2) {
      next.attributes = (next.attributes ?? 0) | TextAttributes.DIM;
    } else if (code === 31) {
      next.fg = ansiPalette.red;
    } else if (code === 32) {
      next.fg = ansiPalette.green;
    } else if (code === 33) {
      next.fg = ansiPalette.yellow;
    } else if (code === 36) {
      next.fg = ansiPalette.cyan;
    } else if (code === 37) {
      next.fg = ansiPalette.white;
    }
  }
  return next;
}

const ansiPalette = {
  cyan: RGBA.fromInts(80, 210, 225),
  green: RGBA.fromInts(110, 210, 125),
  red: RGBA.fromInts(235, 95, 95),
  white: RGBA.fromInts(225, 230, 235),
  yellow: RGBA.fromInts(235, 205, 95)
};

function renderHeader(lines: string[], width: number): string[] {
  return lines.map((line) => fitLine(line, width));
}

function combineColumns(
  leftBox: string[],
  rightBox: string[],
  leftWidth: number,
  rightWidth: number,
  gap: number
): string[] {
  const rows = Math.max(leftBox.length, rightBox.length);
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const left = padVisible(leftBox[index] ?? "", leftWidth);
    const right = padVisible(rightBox[index] ?? "", rightWidth);
    lines.push(`${left}${" ".repeat(gap)}${right}`);
  }
  return lines;
}

function renderBox(
  title: string,
  lines: string[],
  width: number,
  options: DashboardOptions,
  maxInnerLines?: number
): string[] {
  const visibleTitle = ` ${title} `;
  const top = `+${visibleTitle}${"-".repeat(Math.max(0, width - visibleTitle.length - 2))}+`;
  const bottom = `+${"-".repeat(Math.max(0, width - 2))}+`;
  const innerWidth = Math.max(1, width - 4);
  const innerLines = maxInnerLines
    ? padLines(clampLines(lines, maxInnerLines, options), maxInnerLines)
    : lines;
  return [
    style(top, "border", options),
    ...innerLines.map(
      (line) =>
        `${style("|", "border", options)} ${fitLine(line, innerWidth)} ${style("|", "border", options)}`
    ),
    style(bottom, "border", options)
  ];
}

function padLines(lines: string[], targetLength: number): string[] {
  if (lines.length >= targetLength) {
    return lines;
  }
  return [...lines, ...Array.from({ length: targetLength - lines.length }, () => "")];
}

function clampLines(lines: string[], maxLines: number, options: DashboardOptions): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const visibleLines = Math.max(1, maxLines - 1);
  return [
    ...lines.slice(0, visibleLines),
    style(`... ${lines.length - visibleLines} more lines`, "dim", options)
  ];
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
    cleanupPending: tasks.filter(
      (task) => terminalStates.has(task.state) && hasExistingWorktree(task)
    ).length,
    needsAttention: tasks.filter(needsAttention).length,
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
  live: TaskSnapshot[];
  terminal: TaskSnapshot[];
  needsAttention: TaskSnapshot[];
  stale: TaskSnapshot[];
  hiddenTerminal: number;
  hiddenStale: number;
} {
  const active = tasks
    .filter((task) => liveStates.has(task.state))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const stale = tasks
    .filter((task) => task.state === "stale")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const terminal = tasks
    .filter((task) => terminalStates.has(task.state))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const attention = terminal.filter(needsAttention);
  const ordinaryTerminal = terminal.filter((task) => !needsAttention(task));
  const visibleStale = options.showAll
    ? stale
    : stale.filter((task) => now - Date.parse(task.updatedAt) <= freshStaleWindowMs);
  const visibleTerminal = options.showAll
    ? ordinaryTerminal
    : ordinaryTerminal
        .filter((task) => now - Date.parse(task.updatedAt) <= freshTerminalWindowMs)
        .slice(0, maxDefaultTerminalRows);
  return {
    tasks: [...active, ...attention, ...visibleStale, ...visibleTerminal],
    live: active,
    needsAttention: attention,
    stale: visibleStale,
    terminal: visibleTerminal,
    hiddenTerminal: ordinaryTerminal.length - visibleTerminal.length,
    hiddenStale: stale.length - visibleStale.length
  };
}

function formatTaskRow(task: TaskSnapshot, now: number, options: DashboardOptions): string {
  const prefix = liveStates.has(task.state) ? ">>" : needsAttention(task) ? "!!" : "  ";
  const target = formatTarget(task).padEnd(16);
  const state = padVisible(stateBadge(task, options), 16);
  const age = liveStates.has(task.state)
    ? `running ${formatAge(Date.parse(task.createdAt), now)}`
    : `updated ${formatAge(Date.parse(task.updatedAt), now)} ago`;
  const quiet =
    liveStates.has(task.state) || task.state === "stale"
      ? `quiet ${formatQuiet(task, now)}`
      : formatTerminalStatus(task);
  return [prefix, task.id.slice(0, 8), state, target, formatSession(task), age, quiet]
    .filter(Boolean)
    .join("  ");
}

function formatEventRow(event: Event, options: DashboardOptions): string {
  return [
    String(event.seq).padStart(4),
    style(event.type.padEnd(14), eventStyle(event), options),
    oneLine(event.summary, 110)
  ].join(" ");
}

function selectedModeLines(
  selected: TaskSnapshot,
  mode: DashboardMode,
  options: DashboardOptions
): string[] {
  const lines: string[] = [];
  const prompt = selected.prompt ?? selected.promptPreview;
  const finalResponse = selected.finalResponse ?? selected.finalResponsePreview;
  const workerStderr = selected.workerStderr ?? selected.workerStderrPreview;

  if (mode === "prompt") {
    lines.push("");
    lines.push(style("Prompt", "section", options));
    lines.push(...previewBlock(prompt ?? "Prompt not retained for this task.", 18, 112));
    return lines;
  }

  if (mode === "result") {
    lines.push("");
    lines.push(style("Final Response", "section", options));
    lines.push(...previewBlock(finalResponse ?? "No final response yet.", 18, 112));
    return lines;
  }

  if (mode === "stderr") {
    lines.push("");
    lines.push(style("Worker Stderr", workerStderr ? "warn" : "section", options));
    lines.push(...previewBlock(workerStderr ?? "No worker stderr captured.", 18, 112));
    return lines;
  }

  if (prompt) {
    lines.push("");
    lines.push(style("Prompt", "section", options));
    lines.push(...previewBlock(prompt, 5, 112));
  }
  if (finalResponse) {
    lines.push("");
    lines.push(style("Final Response", "section", options));
    lines.push(...previewBlock(finalResponse, 7, 112));
  } else if (liveStates.has(selected.state)) {
    lines.push("");
    lines.push(style("Activity", "section", options));
    lines.push(style("No final response yet.", "dim", options));
  }
  if (workerStderr) {
    lines.push("");
    lines.push(style("Worker Stderr", "warn", options));
    lines.push(...previewBlock(workerStderr, 4, 112));
  }
  return lines;
}

function eventStyle(
  event: Event
): "active" | "bad" | "dim" | "info" | "ok" | "section" | "title" | "warn" {
  if (event.type === "task_activity") {
    return "active";
  }
  if (event.type === "task_state" && /failed|timed_out|cancelled/i.test(event.summary)) {
    return "bad";
  }
  if (event.type === "task_state" && /stale/i.test(event.summary)) {
    return "warn";
  }
  if (event.type === "task_state" && /exited/i.test(event.summary)) {
    return "ok";
  }
  if (event.type === "worktree_status") {
    return "warn";
  }
  return "info";
}

function previewBlock(value: string, maxLines: number, width: number): string[] {
  const lines = wrapText(value.trim(), width);
  if (lines.length === 0) {
    return ["(empty)"];
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  return [...lines.slice(0, maxLines), `... ${lines.length - maxLines} more lines`];
}

function wrapText(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    let remaining = rawLine.trimEnd();
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }
    while (remaining.length > width) {
      const splitAt = remaining.lastIndexOf(" ", width);
      const index = splitAt > 20 ? splitAt : width;
      lines.push(remaining.slice(0, index));
      remaining = remaining.slice(index).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
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

function formatTerminalStatus(task: TaskSnapshot): string {
  if (needsAttention(task)) {
    const reasons = [];
    if (hasExistingWorktree(task)) {
      reasons.push("worktree");
    }
    if (task.state !== "exited") {
      reasons.push(task.state);
    }
    return `needs ${reasons.join("+")}`;
  }
  if (task.state !== "exited") {
    return task.state;
  }
  if (task.exitCode !== undefined) {
    return `exit ${task.exitCode}`;
  }
  return "";
}

function attentionActions(task: TaskSnapshot): string[] {
  const id = task.id.slice(0, 8);
  const actions = [`inspect: codex-fleet status ${id}`, `events: codex-fleet logs ${id}`];
  const worktreePath = existingWorktreePath(task);
  if (worktreePath) {
    actions.push(`diff: git -C ${shellQuote(worktreePath)} status --short`);
    actions.push(`release: codex-fleet cleanup run --task ${id}`);
    actions.push(`force if disposable: codex-fleet cleanup run --task ${id} --force`);
  }
  if (task.state !== "exited" || (task.exitCode ?? 0) !== 0) {
    actions.push("rerun as a new task if the failure is still relevant");
  }
  return actions;
}

function needsAttention(task: TaskSnapshot): boolean {
  if (!terminalStates.has(task.state)) {
    return false;
  }
  return hasExistingWorktree(task);
}

function hasExistingWorktree(task: TaskSnapshot): boolean {
  return Boolean(existingWorktreePath(task));
}

function existingWorktreePath(task: TaskSnapshot): string | undefined {
  return task.worktreePath && existsSync(task.worktreePath) ? task.worktreePath : undefined;
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function fitLine(value: string, width: number): string {
  const line = value.replaceAll("\t", "  ");
  if (visibleLength(line) <= width) {
    return padVisible(line, width);
  }
  const plain = stripAnsi(line);
  if (width <= 3) {
    return plain.slice(0, width);
  }
  return `${plain.slice(0, width - 3)}...`;
}

function padVisible(value: string, width: number): string {
  const padding = width - visibleLength(value);
  return padding > 0 ? `${value}${" ".repeat(padding)}` : value;
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replaceAll(ansiEscapePattern, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function style(
  value: string,
  kind: "active" | "bad" | "border" | "dim" | "info" | "ok" | "section" | "title" | "warn",
  options: DashboardOptions
): string {
  if (!options.color) {
    return value;
  }
  const codes = {
    active: "1;32",
    bad: "1;31",
    border: "2;37",
    dim: "2",
    info: "1;36",
    ok: "32",
    section: "1;37",
    title: "1;36",
    warn: "1;33"
  } satisfies Record<typeof kind, string>;
  return `\u001b[${codes[kind]}m${value}\u001b[0m`;
}
