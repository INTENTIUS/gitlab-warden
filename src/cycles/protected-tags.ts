/**
 * Protected-tags cycle — project protected tags.
 *
 *   fetchLive — GET /projects/:id/protected_tags (paginated), keyed by name
 *   apply
 *     create → POST   /projects/:id/protected_tags
 *     update → DELETE then POST (re-protect; access levels aren't repatchable)
 *     delete → DELETE /projects/:id/protected_tags/:name
 *
 * No-op on group nodes.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, ProtectedTagConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveProtectedTag } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type ProtectedTagsScope = Record<string, never>;

interface GlProtectedTag {
  name?: string;
  create_access_levels?: Array<{ access_level?: number }>;
}

function mapTag(raw: GlProtectedTag): LiveProtectedTag {
  const t: LiveProtectedTag = { name: raw.name ?? "" };
  const lvl = raw.create_access_levels?.[0]?.access_level;
  if (lvl !== undefined) t.createAccessLevel = lvl;
  return t;
}

export function buildTagBody(d: ProtectedTagConfig): Record<string, unknown> {
  const body: Record<string, unknown> = { name: d.name };
  if (d.createAccessLevel !== undefined) body.create_access_level = d.createAccessLevel;
  return body;
}

export const protectedTagsCycle: Cycle<ProtectedTagsScope> = {
  name: "protected-tags",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: ProtectedTagsScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "project") return {};
    charge(budget);
    const raw = await client.paginate<GlProtectedTag>(`/projects/${encodeId(path)}/protected_tags`);
    return { protectedTags: raw.filter((t) => t.name).map(mapTag) };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "project" || !config.protectedTags) return { kind: config.kind };
    return { kind: "project", protectedTags: config.protectedTags };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: ProtectedTagsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "protected-tag") return;
    const { path } = parseScope(scopeId);
    const base = `/projects/${encodeId(path)}/protected_tags`;
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
    await client.request("POST", base, buildTagBody(entry.after as ProtectedTagConfig));
  },
};
