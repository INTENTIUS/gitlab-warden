/**
 * Node-rename cycle — applies a `previously:` rename on a group or project
 * node as a single in-place update (`PUT /groups/:id` / `PUT /projects/:id`
 * with the new path), keeping the id, history, and memberships.
 *
 * This cycle is runner-managed, not registry-listed: the runner resolves each
 * node's `previously:` alias against live state before scope enumeration
 * (see `resolveNodeRenames` in `src/reconcile/runner.ts`), enumerates a
 * pending rename's scope under the OLD path, injects the verified intent as
 * the `nodeRename` slice, and appends this cycle after the selected ones. The
 * ordering matters: every other cycle fetches and applies against the old
 * path (where the resource still lives), and the rename lands last — the next
 * run finds the node at its declared path and the alias goes inert.
 *
 *   fetchLive    — nothing (the runner's alias probe was the read)
 *   buildDesired — the injected `nodeRename` intent, plus the display-name
 *                  policy: the rename PUT sets `name` to the new path's last
 *                  segment unless a settings slice manages the name
 *                  (`groupSettings.name`), so a renamed node doesn't keep a
 *                  stale display name by default
 *   apply        — one PUT against the old (live) path
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, NodeRenameIntent } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type NodeRenameScope = Record<string, never>;

/** Last path segment ("acme/platform/api" → "api"). */
function leaf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export const nodeRenameCycle: Cycle<NodeRenameScope> = {
  name: "node-rename",
  verb: "org-unit",

  // The runner already probed both paths while resolving the alias (that probe
  // is this cycle's read; a re-read here would double the requests for no new
  // information), so fetchLive returns nothing and the diff shapes the
  // injected intent as one update.
  async fetchLive(): Promise<LiveNodeState> {
    return {};
  },

  buildDesired(config: NodeConfig): NodeConfig {
    const rename = config.nodeRename;
    if (!rename || config.kind === "instance") return { kind: config.kind };
    const managedName = config.kind === "group" && config.groupSettings?.name !== undefined;
    const intent: NodeRenameIntent = managedName ? { ...rename } : { ...rename, name: leaf(rename.toPath) };
    return { kind: config.kind, nodeRename: intent };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: NodeRenameScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "node") return;
    const { kind, path } = parseScope(scopeId); // scope path = the old (live) path
    const intent = entry.after as NodeRenameIntent;
    const body: Record<string, unknown> = { path: leaf(intent.toPath) };
    if (intent.name !== undefined) body.name = intent.name;
    const resource = kind === "group" ? "groups" : "projects";
    charge(budget);
    await client.request("PUT", `/${resource}/${encodeId(path)}`, body);
  },
};
