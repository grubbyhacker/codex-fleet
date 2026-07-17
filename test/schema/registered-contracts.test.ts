import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ContinuationBudgetAccount,
  RegisteredTaskRegistry,
  continuationBudgetPolicySchema,
  registeredVerifierResultSchema
} from "@grubbyhacker/session-supervisor";

const budget = continuationBudgetPolicySchema.parse({
  maxContinuations: 1,
  maxModelTurns: 2,
  wallClockDeadlineMs: 60_000,
  maxTotalTokens: 10_000,
  maxRuntimeMs: 30_000,
  perTurnTimeoutMs: 20_000
});
const contractDigest = `sha256:${"a".repeat(64)}`;
const taskEvidenceDigest = `sha256:${"b".repeat(64)}`;

function registry(): RegisteredTaskRegistry {
  return new RegisteredTaskRegistry([
    {
      taskKind: "repository_change_v1",
      completionContract: "repository_state_v1",
      verifierId: "repository_state_v1",
      contractDigest,
      parameterSchema: z
        .object({
          repositoryId: z.string(),
          baseRevision: z.string(),
          branchRef: z.string(),
          taskEvidenceDigest: z.string(),
          validationSelection: z.enum(["required"])
        })
        .strict(),
      allowedReasonCodes: ["head_not_reachable", "validation_stale"],
      budget
    }
  ]);
}

describe("registered task and verifier contracts", () => {
  it("selects verifier and budget only from compiled registered behavior", () => {
    const tasks = registry();
    const task = tasks.resolve(
      "repository_change_v1",
      {
        repositoryId: "neutral",
        baseRevision: "base",
        branchRef: "agent/pr10",
        taskEvidenceDigest: "sha256:task-input",
        validationSelection: "required"
      },
      taskEvidenceDigest
    );
    expect(task).toMatchObject({
      completionContract: "repository_state_v1",
      verifierId: "repository_state_v1",
      contractDigest,
      budget
    });
    expect(() => tasks.resolve("unknown", {}, taskEvidenceDigest)).toThrow(
      "unregistered task kind"
    );
    expect(() =>
      tasks.resolve(
        "repository_change_v1",
        {
          repositoryId: "neutral",
          baseRevision: "base",
          branchRef: "agent/pr10",
          taskEvidenceDigest: "sha256:task-input",
          validationSelection: "required",
          verifier: "shell -c arbitrary"
        },
        taskEvidenceDigest
      )
    ).toThrow();
  });

  it("rejects stale evidence and renders sorted reason codes without evidence text", () => {
    const tasks = registry();
    const task = tasks.resolve(
      "repository_change_v1",
      {
        repositoryId: "neutral",
        baseRevision: "base",
        branchRef: "agent/pr10",
        taskEvidenceDigest: "sha256:task-input",
        validationSelection: "required"
      },
      taskEvidenceDigest
    );
    const result = tasks.validateResult(task, {
      outcome: "missing_or_stale",
      contractDigest: task.contractDigest,
      taskEvidenceDigest: task.taskEvidenceDigest,
      headRevision: "head",
      reasons: [
        { code: "validation_stale", evidenceRef: "opaque-secret-looking-reference" },
        { code: "head_not_reachable" }
      ],
      evidenceRefs: ["evidence-1"]
    });
    const input = tasks.continuationInput(task, result, "turn-1", 1);
    expect(input.reasonCodes).toEqual(["head_not_reachable", "validation_stale"]);
    const prompt = tasks.renderContinuation(input);
    expect(prompt).toContain("Required reason codes: head_not_reachable, validation_stale.");
    expect(prompt).not.toContain("opaque-secret-looking-reference");

    expect(() =>
      tasks.validateResult(task, {
        ...result,
        taskEvidenceDigest: `sha256:${"c".repeat(64)}`
      })
    ).toThrow("stale verifier evidence");
    expect(() =>
      registeredVerifierResultSchema.parse({ ...result, command: "git status" })
    ).toThrow();
  });

  it("cannot accept satisfied evidence without an explicit within-budget decision", () => {
    const tasks = registry();
    const task = tasks.resolve(
      "repository_change_v1",
      {
        repositoryId: "neutral",
        baseRevision: "base",
        branchRef: "agent/pr10",
        taskEvidenceDigest: "sha256:task-input",
        validationSelection: "required"
      },
      taskEvidenceDigest
    );
    const satisfied = {
      outcome: "satisfied",
      contractDigest,
      taskEvidenceDigest,
      headRevision: "head",
      reasons: [],
      evidenceRefs: ["evidence-1"]
    };
    expect(() => tasks.validateResult(task, satisfied)).toThrow(
      "satisfied completion requires an explicit within-budget decision"
    );
    const account = new ContinuationBudgetAccount(budget, 1_000);
    const decision = account.decideCompletion("session-1", 2_000);
    expect(tasks.validateResult(task, satisfied, decision).outcome).toBe("satisfied");
  });
});
