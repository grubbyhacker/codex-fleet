import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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

const repoConfigOverrideSchema = z.object({
  alias: z.string().min(1),
  remoteUrl: z.string().min(1).optional(),
  mirrorPath: z.string().min(1).optional(),
  baseCheckout: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  branchProtected: z.boolean().optional(),
  mergePolicy: mergePolicySchema.optional(),
  verifyCommands: z.array(z.string().min(1)).optional(),
  defaultModelTier: modelTierSchema.optional()
});
type RepoConfigOverride = z.infer<typeof repoConfigOverrideSchema>;

const githubRepositoryCatalogSchema = z.object({
  path: z.string().min(1),
  remoteUrlTemplate: z.string().min(1).default("git@github.com:{owner}/{name}.git"),
  defaultBranch: z.string().min(1).default("main"),
  defaultModelTier: modelTierSchema.default("standard"),
  includeArchived: z.boolean().default(false)
});
type GithubRepositoryCatalog = z.infer<typeof githubRepositoryCatalogSchema>;

const githubCatalogFileSchema = z.object({
  owner: z.string().min(1),
  repositories: z
    .array(
      z.object({
        name: z.string().min(1),
        archived: z.boolean().default(false),
        branch_protection: z
          .object({
            enabled: z.boolean().default(false),
            pattern: z.string().min(1).optional()
          })
          .optional(),
        rulesets: z
          .object({
            default_branch: z
              .object({
                enabled: z.boolean().default(false)
              })
              .optional()
          })
          .optional()
      })
    )
    .default([])
});

const repoRegistrySchema = z.object({
  githubRepositoryCatalogs: z.array(githubRepositoryCatalogSchema).default([]),
  repos: z.array(repoConfigOverrideSchema).default([])
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
    const registryDir = dirname(paths.reposPath);
    const parsed = repoRegistrySchema.parse(JSON.parse(readFileSync(paths.reposPath, "utf8")));
    const repos = new Map<string, RepoConfigOverride>();
    for (const catalog of parsed.githubRepositoryCatalogs) {
      for (const repo of loadGithubRepositoryCatalog(registryDir, catalog)) {
        addRepo(repos, repo, `GitHub repository catalog ${catalog.path}`);
      }
    }
    const explicitAliases = new Set<string>();
    for (const repo of parsed.repos) {
      if (explicitAliases.has(repo.alias)) {
        throw new Error(`Duplicate repo alias "${repo.alias}" in ${paths.reposPath}`);
      }
      explicitAliases.add(repo.alias);
      const existing = repos.get(repo.alias);
      if (existing) {
        repos.set(repo.alias, { ...existing, ...definedFields(repo) });
      } else {
        addRepo(repos, repo, paths.reposPath);
      }
    }
    return new RepoRegistry([...repos.values()].map((repo) => repoConfigSchema.parse(repo)));
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

function loadGithubRepositoryCatalog(
  registryDir: string,
  catalog: GithubRepositoryCatalog
): RepoConfigOverride[] {
  const path = resolveConfiguredPath(registryDir, catalog.path);
  const parsed = githubCatalogFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.repositories
    .filter((repo) => catalog.includeArchived || !repo.archived)
    .map((repo) => {
      const defaultBranch = inferDefaultBranch(repo.branch_protection?.pattern, catalog);
      return {
        alias: repo.name,
        remoteUrl: renderRemoteUrl(catalog.remoteUrlTemplate, parsed.owner, repo.name),
        defaultBranch,
        branchProtected: isProtected(repo),
        defaultModelTier: catalog.defaultModelTier
      };
    });
}

function inferDefaultBranch(
  protectedPattern: string | undefined,
  catalog: GithubRepositoryCatalog
): string {
  if (protectedPattern && !protectedPattern.includes("*")) {
    return protectedPattern;
  }
  return catalog.defaultBranch;
}

function isProtected(repo: {
  branch_protection?: { enabled: boolean };
  rulesets?: { default_branch?: { enabled: boolean } };
}): boolean {
  return Boolean(repo.branch_protection?.enabled || repo.rulesets?.default_branch?.enabled);
}

function renderRemoteUrl(template: string, owner: string, name: string): string {
  return template.replaceAll("{owner}", owner).replaceAll("{name}", name);
}

function resolveConfiguredPath(registryDir: string, path: string): string {
  const expanded = expandConfigPath(path);
  return isAbsolute(expanded) ? expanded : join(registryDir, expanded);
}

function expandConfigPath(path: string): string {
  const homeExpanded = path === "~" ? homedir() : path.replace(/^~\//, `${homedir()}/`);
  return homeExpanded.replaceAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (token, bracedName: string | undefined, bareName: string | undefined) => {
      const name = bracedName ?? bareName;
      const value = name ? process.env[name] : undefined;
      if (!value) {
        throw new Error(`Repo registry path "${path}" references unset environment ${token}`);
      }
      return value;
    }
  );
}

function addRepo(
  repos: Map<string, RepoConfigOverride>,
  repo: RepoConfigOverride,
  source: string
): void {
  if (repos.has(repo.alias)) {
    throw new Error(`Duplicate repo alias "${repo.alias}" in ${source}`);
  }
  repos.set(repo.alias, repo);
}

function definedFields(repo: RepoConfigOverride): RepoConfigOverride {
  return Object.fromEntries(
    Object.entries(repo).filter(([, value]) => value !== undefined)
  ) as RepoConfigOverride;
}
