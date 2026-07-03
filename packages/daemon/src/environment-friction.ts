export type EnvironmentFrictionKind = "missing_command" | "missing_module" | "tool_fallback";

export type EnvironmentFrictionSource = "final_response" | "worker_stderr" | "worker_error";

export type EnvironmentFrictionPayload = {
  kind: EnvironmentFrictionKind;
  source: EnvironmentFrictionSource;
  runtime?: "python" | "node" | "ruby" | "shell" | "unknown";
  tool?: string;
  module?: string;
  evidence: string;
};

type FrictionInput = {
  finalResponse?: string;
  workerStderr?: string;
  workerError?: string;
};

const MAX_EVIDENCE_LENGTH = 240;
const MAX_SIGNALS_PER_SOURCE = 20;

export function detectEnvironmentFriction(input: FrictionInput): EnvironmentFrictionPayload[] {
  const signals = [
    ...detectSource("final_response", input.finalResponse),
    ...detectSource("worker_stderr", input.workerStderr),
    ...detectSource("worker_error", input.workerError)
  ];
  const seen = new Set<string>();
  const deduped: EnvironmentFrictionPayload[] = [];

  for (const signal of signals) {
    const key = [
      signal.kind,
      signal.source,
      signal.runtime ?? "",
      signal.tool ?? "",
      signal.module ?? ""
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(signal);
  }

  return deduped;
}

function detectSource(
  source: EnvironmentFrictionSource,
  text: string | undefined
): EnvironmentFrictionPayload[] {
  if (!text?.trim()) {
    return [];
  }

  const signals: EnvironmentFrictionPayload[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines.slice(-2_000)) {
    signals.push(...detectLine(source, line));
    if (signals.length >= MAX_SIGNALS_PER_SOURCE) {
      break;
    }
  }
  return signals;
}

function detectLine(source: EnvironmentFrictionSource, line: string): EnvironmentFrictionPayload[] {
  const evidence = sanitizeEvidence(line);
  const signals: EnvironmentFrictionPayload[] = [];

  const explicit = line.match(/^\s*Fleet environment friction:\s*(.+)$/i);
  if (explicit) {
    signals.push({
      kind: "tool_fallback",
      source,
      runtime: "unknown",
      evidence: sanitizeEvidence(explicit[1] ?? line)
    });
  }

  const shellCommand = firstMatch(line, [
    /(?:^|\s)([\w./+-]+):\s+command not found\b/i,
    /\bcommand not found:\s+([\w./+-]+)/i,
    /\b(?:spawn|exec):?\s+([\w./+-]+)\s+ENOENT\b/i,
    /\bENOENT\b.*?\b(?:spawn|exec)\s+([\w./+-]+)/i
  ]);
  if (shellCommand) {
    signals.push({
      kind: "missing_command",
      source,
      runtime: "shell",
      tool: normalizeTool(shellCommand),
      evidence
    });
  }

  const pythonModule = firstMatch(line, [
    /ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/,
    /ImportError:\s+No module named ['"]([^'"]+)['"]/,
    /ImportError:\s+cannot import name ['"]([^'"]+)['"]/
  ]);
  if (pythonModule) {
    signals.push({
      kind: "missing_module",
      source,
      runtime: "python",
      module: pythonModule,
      evidence
    });
  }

  const nodeModule = firstMatch(line, [
    /Error:\s+Cannot find module ['"]([^'"]+)['"]/,
    /\bCannot find package ['"]([^'"]+)['"]/
  ]);
  if (nodeModule) {
    signals.push({
      kind: "missing_module",
      source,
      runtime: "node",
      module: nodeModule,
      evidence
    });
  }

  const rubyModule = firstMatch(line, [/cannot load such file -- ([\w./-]+)/i]);
  if (rubyModule) {
    signals.push({
      kind: "missing_module",
      source,
      runtime: "ruby",
      module: rubyModule,
      evidence
    });
  }

  return signals;
}

function firstMatch(line: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function normalizeTool(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? value;
}

function sanitizeEvidence(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  const redacted = singleLine
    .replace(/(token|password|secret|key)=\S+/gi, "$1=<redacted>")
    .replace(/(ghp|gho|github_pat)_[A-Za-z0-9_]+/g, "<redacted-token>");
  return redacted.length > MAX_EVIDENCE_LENGTH
    ? `${redacted.slice(0, MAX_EVIDENCE_LENGTH - 3)}...`
    : redacted;
}
