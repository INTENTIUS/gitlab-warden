/**
 * Protected-environments cycle — group and project protected environments
 * (Premium; tolerate 403).
 *
 *   fetchLive — GET /{groups|projects}/:id/protected_environments (paginated)
 *   apply
 *     create → POST   …/protected_environments
 *     update → DELETE then POST (re-protect)
 *     delete → DELETE …/protected_environments/:name
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, ProtectedEnvironmentConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveProtectedEnvironment } from "../reconcile/live.js";
import { charge, isForbidden } from "./_shared.js";

export type ProtectedEnvironmentsScope = Record<string, never>;

interface GlProtectedEnv {
  name?: string;
  deploy_access_levels?: Array<{ access_level?: number }>;
  required_approval_count?: number;
}

function mapEnv(raw: GlProtectedEnv): LiveProtectedEnvironment {
  const e: LiveProtectedEnvironment = { name: raw.name ?? "" };
  const levels = raw.deploy_access_levels?.map((l) => l.access_level).filter((n): n is number => typeof n === "number");
  if (levels && levels.length) e.deployAccessLevels = levels;
  if (typeof raw.required_approval_count === "number") e.requiredApprovalCount = raw.required_approval_count;
  return e;
}

export function buildEnvBody(d: ProtectedEnvironmentConfig): Record<string, unknown> {
  const body: Record<string, unknown> = { name: d.name };
  if (d.deployAccessLevels !== undefined) body.deploy_access_levels = d.deployAccessLevels.map((access_level) => ({ access_level }));
  if (d.requiredApprovalCount !== undefined) body.required_approval_count = d.requiredApprovalCount;
  return body;
}

function resourceFor(scopeId: string): { base: string } {
  const { kind, path } = parseScope(scopeId);
  const resource = kind === "group" ? "groups" : "projects";
  return { base: `/${resource}/${encodeId(path)}/protected_environments` };
}

export const protectedEnvironmentsCycle: Cycle<ProtectedEnvironmentsScope> = {
  name: "protected-environments",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: ProtectedEnvironmentsScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { base } = resourceFor(scopeId);
    charge(budget);
    try {
      const raw = await client.paginate<GlProtectedEnv>(base);
      return { protectedEnvironments: raw.filter((e) => e.name).map(mapEnv) };
    } catch (err) {
      if (isForbidden(err)) return {}; // Premium-gated → unmanaged
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (!config.protectedEnvironments) return { kind: config.kind };
    return { kind: config.kind, protectedEnvironments: config.protectedEnvironments };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: ProtectedEnvironmentsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "protected-environment") return;
    const { base } = resourceFor(scopeId);
    const name = entry.key;
    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", `${base}/${encodeId(name)}`);
      return;
    }
    if (entry.kind === "update") {
      charge(budget);
      await client.request("DELETE", `${base}/${encodeId(name)}`);
    }
    charge(budget);
    await client.request("POST", base, buildEnvBody(entry.after as ProtectedEnvironmentConfig));
  },
};
