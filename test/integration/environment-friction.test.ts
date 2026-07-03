import { describe, expect, it } from "vitest";

import { detectEnvironmentFriction } from "../../packages/daemon/src/environment-friction.js";

describe("environment friction detection", () => {
  it("detects shell command misses", () => {
    expect(
      detectEnvironmentFriction({
        workerStderr: "zsh:1: yq: command not found"
      })
    ).toContainEqual(
      expect.objectContaining({
        kind: "missing_command",
        source: "worker_stderr",
        runtime: "shell",
        tool: "yq"
      })
    );
  });

  it("detects missing Python modules", () => {
    expect(
      detectEnvironmentFriction({
        finalResponse: "Traceback...\nModuleNotFoundError: No module named 'yaml'"
      })
    ).toContainEqual(
      expect.objectContaining({
        kind: "missing_module",
        source: "final_response",
        runtime: "python",
        module: "yaml"
      })
    );
  });

  it("detects missing Node and Ruby modules", () => {
    const signals = detectEnvironmentFriction({
      workerError: [
        "Error: Cannot find module 'js-yaml'",
        "LoadError: cannot load such file -- psych"
      ].join("\n")
    });

    expect(signals).toContainEqual(
      expect.objectContaining({
        kind: "missing_module",
        source: "worker_error",
        runtime: "node",
        module: "js-yaml"
      })
    );
    expect(signals).toContainEqual(
      expect.objectContaining({
        kind: "missing_module",
        source: "worker_error",
        runtime: "ruby",
        module: "psych"
      })
    );
  });

  it("detects explicit worker fallback reports", () => {
    expect(
      detectEnvironmentFriction({
        finalResponse:
          "Fleet environment friction: Python lacks PyYAML, used Ruby YAML parser instead."
      })
    ).toEqual([
      expect.objectContaining({
        kind: "tool_fallback",
        source: "final_response",
        runtime: "unknown",
        evidence: "Python lacks PyYAML, used Ruby YAML parser instead."
      })
    ]);
  });

  it("deduplicates repeated signals and truncates evidence", () => {
    const signals = detectEnvironmentFriction({
      workerStderr: [
        `ModuleNotFoundError: No module named 'yaml' ${"details ".repeat(80)}`,
        "ModuleNotFoundError: No module named 'yaml'"
      ].join("\n")
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "missing_module",
      runtime: "python",
      module: "yaml"
    });
    expect(signals[0]?.evidence.length).toBeLessThanOrEqual(240);
  });
});
