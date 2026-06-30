import { existsSync, readFileSync } from "node:fs";

import {
  mergePolicySchema,
  modelTierSchema,
  type MergePolicy,
  type TargetDescriptor
} from "@codex-fleet/shared";
import { z } from "zod";

import type { FleetPaths } from "../paths.js";

export const repoConfigSchema = z
  .object({
    alias: z.string().min(1),
    remoteUrl: z.string().min(1).optional(),
    mirrorPath: z.string().min(1).optional(),
    baseCheckout: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).default("main"),
    branchProtected: z.boolean().default(true),
    mergePolicy: mergePolicySchema.optional(),
    verifyCommands: z.array(z.string().min(1)).default([]),
    defaultModelTier: modelTierSchema.default("standard")
  })
  .transform((repo) => ({
    ...repo,
    mergePolicy: repo.mergePolicy ?? defaultMergePolicy(repo.branchProtected)
  }))
  .refine((repo) => repo.remoteUrl || repo.baseCheckout, {
    message: "repo config requires remoteUrl or baseCheckout"
  });
export type RepoConfig = z.infer<typeof repoConfigSchema>;

const repoRegistrySchema = z.object({
  repos: z.array(repoConfigSchema).default([])
});

export class RepoRegistry {
  private readonly repos: RepoConfig[];

  constructor(repos: RepoConfig[]) {
    this.repos = repos;
  }

  static load(paths: FleetPaths): RepoRegistry {
    if (!existsSync(paths.reposPath)) {
      return new RepoRegistry([]);
    }
    const parsed = repoRegistrySchema.parse(JSON.parse(readFileSync(paths.reposPath, "utf8")));
    return new RepoRegistry(parsed.repos);
  }

  listDescriptors(): TargetDescriptor[] {
    return this.repos.map((repo) => ({
      id: repo.alias,
      target: { repo: repo.alias },
      title: repo.alias,
      defaultModelTier: repo.defaultModelTier,
      availableModelTiers: ["cheap", "standard", "strong"],
      verifyCommands: repo.verifyCommands,
      defaultBranch: repo.defaultBranch,
      branchProtected: repo.branchProtected,
      mergePolicy: repo.mergePolicy
    }));
  }

  get(alias: string): RepoConfig | undefined {
    return this.repos.find((repo) => repo.alias === alias);
  }
}

function defaultMergePolicy(branchProtected: boolean): MergePolicy {
  return branchProtected ? "human_review" : "agent_merge_explicit";
}
