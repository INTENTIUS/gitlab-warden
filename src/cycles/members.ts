/**
 * Members cycle — direct membership of group and project nodes.
 *
 * THE inheritance-aware cycle (see DESIGN.md §2). It reads the **direct** roster
 * (`GET /groups|projects/:id/members`, never `/members/all`), so an inherited
 * member is never present in `live` and can never become a delete candidate.
 *
 *   fetchLive    — direct members (paginated) → LiveMember[]
 *   buildDesired — config.members
 *   apply
 *     create → resolve user_id, POST   …/members
 *     update → PUT    …/members/:user_id  (access level / role drift)
 *     delete → DELETE …/members/:user_id  (direct members only)
 *
 * Identity key is the **username** — config should use usernames (numeric ids
 * are resolved on create but the diff keys by username). Endpoints are selected
 * from the node kind (group vs project).
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, MemberConfig } from "../config/types.js";
import { toAccessNumber } from "../config/access-levels.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveMember } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type MembersScope = Record<string, never>;

interface GlMember {
  id?: number;
  username?: string;
  access_level?: number;
  expires_at?: string | null;
  member_role?: { id?: number } | null;
}

/** `groups` or `projects` segment for a node kind. */
function resourceFor(scopeId: string): { resource: string; path: string } {
  const { kind, path } = parseScope(scopeId);
  return { resource: kind === "group" ? "groups" : "projects", path };
}

async function resolveUserId(client: GitLabClient, user: string | number, budget: RateBudget): Promise<number> {
  if (typeof user === "number") return user;
  charge(budget);
  const found = await client.request<Array<{ id?: number }>>("GET", `/users?username=${encodeId(user)}`);
  const id = Array.isArray(found) ? found[0]?.id : undefined;
  if (typeof id !== "number") throw new Error(`could not resolve username '${user}' to a user id`);
  return id;
}

export const membersCycle: Cycle<MembersScope> = {
  name: "members",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: MembersScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { resource, path } = resourceFor(scopeId);
    charge(budget);
    // DIRECT members only — `/members`, never `/members/all` (DESIGN.md §2).
    const raw = await client.paginate<GlMember>(`/${resource}/${encodeId(path)}/members`);
    const members: LiveMember[] = raw
      .filter((m): m is GlMember & { id: number; username: string } => typeof m.id === "number" && typeof m.username === "string")
      .map((m) => ({
        userId: m.id,
        username: m.username,
        accessLevel: m.access_level ?? 0,
        ...(m.member_role?.id != null ? { memberRoleId: m.member_role.id } : {}),
        ...(m.expires_at ? { expiresAt: m.expires_at } : {}),
      }));
    return { members };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (!config.members) return { kind: config.kind };
    return { kind: config.kind, members: config.members };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: MembersScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "member") return;
    const { resource, path } = resourceFor(scopeId);
    const base = `/${resource}/${encodeId(path)}/members`;

    if (entry.kind === "delete") {
      const before = entry.before as LiveMember;
      charge(budget);
      await client.request("DELETE", `${base}/${before.userId}`);
      return;
    }

    if (entry.kind === "update") {
      const before = entry.before as LiveMember;
      const after = entry.after as MemberConfig;
      const body: Record<string, unknown> = { access_level: toAccessNumber(after.accessLevel) };
      if (after.memberRoleId !== undefined) body.member_role_id = after.memberRoleId;
      charge(budget);
      await client.request("PUT", `${base}/${before.userId}`, body);
      return;
    }

    // create
    const after = entry.after as MemberConfig;
    const userId = await resolveUserId(client, after.user, budget);
    const body: Record<string, unknown> = { user_id: userId, access_level: toAccessNumber(after.accessLevel) };
    if (after.memberRoleId !== undefined) body.member_role_id = after.memberRoleId;
    if (after.expiresAt !== undefined) body.expires_at = after.expiresAt;
    charge(budget);
    await client.request("POST", base, body);
  },
};
