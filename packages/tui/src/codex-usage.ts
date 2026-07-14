import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

export type CodexTokenBreakdown = {
  calls: number;
  cachedInput: number;
  input: number;
  output: number;
  reasoningOutput: number;
  total: number;
  unclassified: number;
  uncachedInput: number;
};

export type CodexModelUsage = {
  model: string;
  total: number;
};

export type CodexUsageSummary = {
  daily: CodexTokenBreakdown | undefined;
  dailyModels: CodexModelUsage[];
  monthly: CodexTokenBreakdown | undefined;
  source: "local" | "unavailable";
  weekly: CodexTokenBreakdown | undefined;
};

export type CodexRolloutSource = {
  fallbackModel?: string;
  path: string;
};

type MutableBreakdown = Omit<CodexTokenBreakdown, "uncachedInput">;

type TokenUsage = {
  cached_input_tokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
};

type RolloutEvent = {
  payload?: {
    info?: { last_token_usage?: TokenUsage };
    model?: unknown;
    type?: unknown;
  };
  timestamp?: unknown;
  type?: unknown;
};

export async function readLocalCodexUsage(now = new Date()): Promise<CodexUsageSummary> {
  const dbPath = codexStateDbPath();
  if (!dbPath) {
    return unavailableCodexUsage();
  }

  const earliest = Math.min(
    startOfLocalDay(now).getTime(),
    startOfLocalWeek(now).getTime(),
    startOfLocalMonth(now).getTime()
  );
  const query = `
    select rollout_path as path, coalesce(model, 'unknown') as fallbackModel
    from threads
    where updated_at >= ${Math.floor(earliest / 1_000)};
  `;
  const proc = Bun.spawnSync(["sqlite3", "-json", dbPath, query], {
    stderr: "pipe",
    stdout: "pipe"
  });
  if (proc.exitCode !== 0) {
    return unavailableCodexUsage();
  }

  try {
    const output = proc.stdout.toString().trim();
    const sources = output ? (JSON.parse(output) as CodexRolloutSource[]) : [];
    return await summarizeCodexRollouts(sources, now);
  } catch {
    return unavailableCodexUsage();
  }
}

export async function summarizeCodexRollouts(
  sources: CodexRolloutSource[],
  now: Date
): Promise<CodexUsageSummary> {
  const starts = {
    daily: startOfLocalDay(now).getTime(),
    monthly: startOfLocalMonth(now).getTime(),
    weekly: startOfLocalWeek(now).getTime()
  };
  const periods = {
    daily: emptyBreakdown(),
    monthly: emptyBreakdown(),
    weekly: emptyBreakdown()
  };
  const dailyModels = new Map<string, number>();

  for (const source of sources) {
    if (!existsSync(source.path)) {
      continue;
    }
    let activeModel = source.fallbackModel ?? "unknown";
    const lines = createInterface({
      crlfDelay: Infinity,
      input: createReadStream(source.path, { encoding: "utf8" })
    });
    try {
      for await (const line of lines) {
        if (!line.includes('"type":"token_count"') && !line.includes('"type":"turn_context"')) {
          continue;
        }
        const event = parseRolloutEvent(line);
        if (!event) {
          continue;
        }
        if (event.type === "turn_context" && typeof event.payload?.model === "string") {
          activeModel = event.payload.model;
          continue;
        }
        if (event.type !== "event_msg" || event.payload?.type !== "token_count") {
          continue;
        }
        const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
        const usage = event.payload.info?.last_token_usage;
        if (!usage || !Number.isFinite(timestamp)) {
          continue;
        }
        const tokens = normalizeUsage(usage);
        if (timestamp >= starts.monthly) {
          addUsage(periods.monthly, tokens);
        }
        if (timestamp >= starts.weekly) {
          addUsage(periods.weekly, tokens);
        }
        if (timestamp >= starts.daily) {
          addUsage(periods.daily, tokens);
          dailyModels.set(activeModel, (dailyModels.get(activeModel) ?? 0) + tokens.total);
        }
      }
    } catch {
      // A concurrently rotated or partially written rollout should not break the dashboard.
    } finally {
      lines.close();
    }
  }

  return {
    daily: finishBreakdown(periods.daily),
    dailyModels: [...dailyModels.entries()]
      .map(([model, total]) => ({ model, total }))
      .sort((left, right) => right.total - left.total),
    monthly: finishBreakdown(periods.monthly),
    source: "local",
    weekly: finishBreakdown(periods.weekly)
  };
}

export function unavailableCodexUsage(): CodexUsageSummary {
  return {
    daily: undefined,
    dailyModels: [],
    monthly: undefined,
    source: "unavailable",
    weekly: undefined
  };
}

function parseRolloutEvent(line: string): RolloutEvent | undefined {
  try {
    const parsed = JSON.parse(line) as RolloutEvent;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeUsage(usage: TokenUsage): MutableBreakdown {
  const input = tokenNumber(usage.input_tokens);
  const output = tokenNumber(usage.output_tokens);
  const total = tokenNumber(usage.total_tokens);
  return {
    calls: total > 0 ? 1 : 0,
    cachedInput: tokenNumber(usage.cached_input_tokens),
    input,
    output,
    reasoningOutput: tokenNumber(usage.reasoning_output_tokens),
    total,
    unclassified: Math.max(0, total - input - output)
  };
}

function tokenNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyBreakdown(): MutableBreakdown {
  return {
    calls: 0,
    cachedInput: 0,
    input: 0,
    output: 0,
    reasoningOutput: 0,
    total: 0,
    unclassified: 0
  };
}

function addUsage(target: MutableBreakdown, usage: MutableBreakdown): void {
  target.calls += usage.calls;
  target.cachedInput += usage.cachedInput;
  target.input += usage.input;
  target.output += usage.output;
  target.reasoningOutput += usage.reasoningOutput;
  target.total += usage.total;
  target.unclassified += usage.unclassified;
}

function finishBreakdown(value: MutableBreakdown): CodexTokenBreakdown {
  return {
    ...value,
    uncachedInput: Math.max(0, value.input - value.cachedInput)
  };
}

function codexStateDbPath(): string | undefined {
  const home = process.env.CODEX_HOME ?? `${process.env.HOME ?? ""}/.codex`;
  const candidates = [`${home}/state_5.sqlite`, `${home}/sqlite/state_5.sqlite`];
  return candidates.find((candidate) => existsSync(candidate));
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function startOfLocalWeek(value: Date): Date {
  const day = value.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + mondayOffset);
}

function startOfLocalMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}
