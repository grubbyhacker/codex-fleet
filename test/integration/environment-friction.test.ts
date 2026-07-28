import { describe, expect, it } from "vitest";

import { detectEnvironmentFriction } from "../../packages/daemon/src/environment-friction.js";

describe("environment friction detection", () => {
  it.each([
    ["command not found", "zsh:1: yq: command not found", "yq"],
    ["POSIX not found", "/bin/sh: fd: not found", "fd"],
    ["spawn ENOENT", "Error: spawn pnpm ENOENT", "pnpm"],
    ["exec failure", 'exec: "rg": executable file not found in $PATH', "rg"],
    ["fork/exec failure", "fork/exec /usr/local/bin/go: no such file or directory", "go"]
  ])("detects shell %s", (_name, stderr, tool) => {
    expect(detectEnvironmentFriction({ workerStderr: stderr })).toContainEqual(
      expect.objectContaining({
        kind: "missing_command",
        source: "worker_stderr",
        runtime: "shell",
        tool
      })
    );
  });

  it.each([
    ["ModuleNotFoundError", "ModuleNotFoundError: No module named 'yaml'", "yaml"],
    ["ImportError", "ImportError: No module named 'tomllib'", "tomllib"]
  ])("detects Python %s", (_name, workerError, module) => {
    expect(detectEnvironmentFriction({ workerError })).toContainEqual(
      expect.objectContaining({
        kind: "missing_module",
        source: "worker_error",
        runtime: "python",
        module
      })
    );
  });

  it("detects missing Node and Ruby modules", () => {
    const signals = detectEnvironmentFriction({
      workerError: [
        "Error: Cannot find module 'js-yaml'",
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'kleur' imported from /app/index.mjs",
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
        runtime: "node",
        module: "kleur"
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

  it.each([
    ["missing tool", 'go: no such tool "compile"', "missing_command", "tool", "compile"],
    ["missing toolchain", "go: toolchain not available", "missing_command", "tool", "go"],
    [
      "unresolved module",
      "no required module provides package example.com/acme/widget; to add it:",
      "missing_module",
      "module",
      "example.com/acme/widget"
    ],
    [
      "unresolved GOPATH import",
      'cannot find package "example.com/acme/legacy" in any of:',
      "missing_module",
      "module",
      "example.com/acme/legacy"
    ]
  ])("detects Go %s", (_name, workerStderr, kind, property, value) => {
    expect(detectEnvironmentFriction({ workerStderr })).toContainEqual(
      expect.objectContaining({
        kind,
        source: "worker_stderr",
        runtime: "go",
        [property]: value
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

  it("does not treat final-response prose that quotes an error as friction", () => {
    expect(
      detectEnvironmentFriction({
        finalResponse:
          "The test named \"returns ModuleNotFoundError: No module named 'yaml'\" is expected to pass."
      })
    ).toEqual([]);
  });
});
