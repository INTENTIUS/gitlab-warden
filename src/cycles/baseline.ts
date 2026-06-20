/**
 * Baseline cycle — ensures declared subgroups and projects *exist* under a group
 * node (provisioning; existence-only).
 *
 *   fetchLive — existing children: GET /groups/:id/subgroups + /projects (names)
 *   apply     — create when absent:
 *       · group   → POST /groups   { path, parent_id, … }
 *       · project → POST /projects { path, namespace_id, … }
 *
 * Both need the parent group's numeric id, resolved once per create. Settings of
 * the created node are the settings cycles' concern.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, BaselineConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type BaselineScope = Record<string, never>;

interface GlChild {
  path?: string;
}

export const baselineCycle: Cycle<BaselineScope> = {
  name: "baseline",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: BaselineScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "group") return {}; // children are provisioned under groups
    charge(budget);
    const subs = await client.paginate<GlChild>(`/groups/${encodeId(path)}/subgroups`);
    charge(budget);
    const projs = await client.paginate<GlChild>(`/groups/${encodeId(path)}/projects`);
    const children = [...subs, ...projs].map((c) => c.path).filter((p): p is string => typeof p === "string");
    return { children };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "group" || !config.baselines) return { kind: config.kind };
    return { kind: "group", baselines: config.baselines };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: BaselineScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "baseline" || entry.kind !== "create") return;
    const { path } = parseScope(scopeId);
    const b = entry.after as BaselineConfig;

    charge(budget);
    const parent = await client.request<{ id?: number }>("GET", `/groups/${encodeId(path)}`);
    if (typeof parent.id !== "number") throw new Error(`parent group '${path}' has no id`);

    const common = { name: b.name ?? b.path, path: b.path, ...(b.visibility ? { visibility: b.visibility } : {}) };
    charge(budget);
    if (b.kind === "group") {
      await client.request("POST", `/groups`, { ...common, parent_id: parent.id });
    } else {
      await client.request("POST", `/projects`, {
        ...common,
        namespace_id: parent.id,
        ...(b.template ? { template_name: b.template } : {}),
      });
    }
  },
};
