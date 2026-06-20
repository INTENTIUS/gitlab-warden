/**
 * Advanced project protections cycle.
 *
 * v1 covers the CI/CD **job token scope** (project) — whether other projects
 * must be allowlisted to use this project's job token (an inbound-access
 * hardening control):
 *   fetchLive — GET   /projects/:id/job_token_scope  → { inbound_enabled }
 *   apply     — PATCH /projects/:id/job_token_scope  { enabled }
 *
 * Container/package registry protection rules are deferred sub-surfaces (newer,
 * version-sensitive endpoints) — to be added incrementally under #28.
 * Project-only; 403/404 tolerated.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, JobTokenScopeConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState } from "../reconcile/live.js";
import { charge, isForbidden, isNotFound } from "./_shared.js";

export type AdvancedProtectionsScope = Record<string, never>;

interface GlJobTokenScope {
  inbound_enabled?: boolean;
}

export const advancedProtectionsCycle: Cycle<AdvancedProtectionsScope> = {
  name: "advanced-protections",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: AdvancedProtectionsScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "project") return {};
    charge(budget);
    try {
      const raw = await client.request<GlJobTokenScope>("GET", `/projects/${encodeId(path)}/job_token_scope`);
      const scope: LiveNodeState["jobTokenScope"] = {};
      if (typeof raw.inbound_enabled === "boolean") scope.inboundEnabled = raw.inbound_enabled;
      return { jobTokenScope: scope };
    } catch (err) {
      if (isForbidden(err) || isNotFound(err)) return {};
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "project" || !config.jobTokenScope) return { kind: config.kind };
    return { kind: "project", jobTokenScope: config.jobTokenScope };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: AdvancedProtectionsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "job-token-scope") return;
    const { path } = parseScope(scopeId);
    const d = entry.after as JobTokenScopeConfig;
    if (d.inboundEnabled === undefined) return;
    charge(budget);
    await client.request("PATCH", `/projects/${encodeId(path)}/job_token_scope`, { enabled: d.inboundEnabled });
  },
};
