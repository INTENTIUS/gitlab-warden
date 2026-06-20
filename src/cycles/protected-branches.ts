/**
 * Protected-branches cycle — project branch protections (project-only in v4).
 *
 *   fetchLive — GET /projects/:id/protected_branches (paginated), keyed by name
 *   apply
 *     create → POST   /projects/:id/protected_branches
 *     update → DELETE then POST (GitLab can't repatch access levels in place)
 *     delete → DELETE /projects/:id/protected_branches/:name
 *
 * No-op on group nodes. CE access-level model (single numeric push/merge/
 * unprotect level). EE-only fields that 403 surface in failed[] (tolerated).
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, ProtectedBranchConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveProtectedBranch } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type ProtectedBranchesScope = Record<string, never>;

interface GlAccess {
  access_level?: number;
}
interface GlProtectedBranch {
  name?: string;
  push_access_levels?: GlAccess[];
  merge_access_levels?: GlAccess[];
  unprotect_access_levels?: GlAccess[];
  allow_force_push?: boolean;
  code_owner_approval_required?: boolean;
}

function firstLevel(levels?: GlAccess[]): number | undefined {
  return levels && levels.length > 0 ? levels[0]!.access_level : undefined;
}

function mapBranch(raw: GlProtectedBranch): LiveProtectedBranch {
  const b: LiveProtectedBranch = { name: raw.name ?? "" };
  const push = firstLevel(raw.push_access_levels);
  const merge = firstLevel(raw.merge_access_levels);
  const unprotect = firstLevel(raw.unprotect_access_levels);
  if (push !== undefined) b.pushAccessLevel = push;
  if (merge !== undefined) b.mergeAccessLevel = merge;
  if (unprotect !== undefined) b.unprotectAccessLevel = unprotect;
  if (typeof raw.allow_force_push === "boolean") b.allowForcePush = raw.allow_force_push;
  if (typeof raw.code_owner_approval_required === "boolean") b.codeOwnerApprovalRequired = raw.code_owner_approval_required;
  return b;
}

/** Build the `POST …/protected_branches` body (name + declared access levels). */
export function buildBranchBody(d: ProtectedBranchConfig): Record<string, unknown> {
  const body: Record<string, unknown> = { name: d.name };
  if (d.pushAccessLevel !== undefined) body.push_access_level = d.pushAccessLevel;
  if (d.mergeAccessLevel !== undefined) body.merge_access_level = d.mergeAccessLevel;
  if (d.unprotectAccessLevel !== undefined) body.unprotect_access_level = d.unprotectAccessLevel;
  if (d.allowForcePush !== undefined) body.allow_force_push = d.allowForcePush;
  if (d.codeOwnerApprovalRequired !== undefined) body.code_owner_approval_required = d.codeOwnerApprovalRequired;
  return body;
}

export const protectedBranchesCycle: Cycle<ProtectedBranchesScope> = {
  name: "protected-branches",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: ProtectedBranchesScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "project") return {};
    charge(budget);
    const raw = await client.paginate<GlProtectedBranch>(`/projects/${encodeId(path)}/protected_branches`);
    return { protectedBranches: raw.filter((b) => b.name).map(mapBranch) };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "project" || !config.protectedBranches) return { kind: config.kind };
    return { kind: "project", protectedBranches: config.protectedBranches };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: ProtectedBranchesScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "protected-branch") return;
    const { path } = parseScope(scopeId);
    const base = `/projects/${encodeId(path)}/protected_branches`;
    const name = entry.key;

    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", `${base}/${encodeId(name)}`);
      return;
    }
    if (entry.kind === "update") {
      // GitLab can't repatch access levels in place — re-protect.
      charge(budget);
      await client.request("DELETE", `${base}/${encodeId(name)}`);
    }
    charge(budget);
    await client.request("POST", base, buildBranchBody(entry.after as ProtectedBranchConfig));
  },
};
