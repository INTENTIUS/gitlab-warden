/**
 * Member-roles cycle — custom roles (Ultimate), via the REST member_roles API.
 *
 *   group node    → /groups/:id/member_roles
 *   instance node → /member_roles  (self-managed)
 *
 *   fetchLive — GET (paginated) → LiveMemberRole[] (Ultimate 403 tolerated)
 *   apply     — POST on create, DELETE /:id on delete (presence; keyed by name)
 *
 * Role assignment is the members cycle's job (a member references a role id);
 * this cycle owns the role definitions. Project nodes are a no-op.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, MemberRoleConfig } from "../config/types.js";
import { toAccessNumber } from "../config/access-levels.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveMemberRole } from "../reconcile/live.js";
import { charge, isForbidden } from "./_shared.js";

export type MemberRolesScope = Record<string, never>;

interface GlMemberRole {
  id?: number;
  name?: string;
  base_access_level?: number;
  enabled_permissions?: string[] | { nodes?: Array<{ value?: string }> };
}

function mapRole(raw: GlMemberRole): LiveMemberRole {
  const r: LiveMemberRole = { name: raw.name ?? "" };
  if (typeof raw.id === "number") r.id = raw.id;
  if (typeof raw.base_access_level === "number") r.baseAccessLevel = raw.base_access_level;
  if (Array.isArray(raw.enabled_permissions)) r.permissions = raw.enabled_permissions;
  return r;
}

/** member_roles base path for a node (group vs self-managed instance). */
function baseFor(scopeId: string): string | null {
  const { kind, path } = parseScope(scopeId);
  if (kind === "group") return `/groups/${encodeId(path)}/member_roles`;
  if (kind === "instance") return `/member_roles`;
  return null; // project nodes: no member roles
}

export const memberRolesCycle: Cycle<MemberRolesScope> = {
  name: "member-roles",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: MemberRolesScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const base = baseFor(scopeId);
    if (!base) return {};
    charge(budget);
    try {
      const raw = await client.paginate<GlMemberRole>(base);
      return { memberRoles: raw.filter((r) => r.name).map(mapRole) };
    } catch (err) {
      if (isForbidden(err)) return {}; // Ultimate-gated → unmanaged
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind === "project" || !config.memberRoles) return { kind: config.kind };
    return { kind: config.kind, memberRoles: config.memberRoles };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: MemberRolesScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "member-role") return;
    const base = baseFor(scopeId);
    if (!base) return;
    if (entry.kind === "create") {
      const d = entry.after as MemberRoleConfig;
      charge(budget);
      await client.request("POST", base, {
        name: d.name,
        base_access_level: toAccessNumber(d.baseAccessLevel),
        ...(d.permissions ? { permissions: d.permissions } : {}),
      });
      return;
    }
    if (entry.kind === "delete") {
      const id = (entry.before as LiveMemberRole | undefined)?.id;
      if (typeof id !== "number") throw new Error(`member role '${entry.key}' has no live id`);
      charge(budget);
      await client.request("DELETE", `${base}/${id}`);
    }
  },
};
