/**
 * Node-rename cycle — applies a `previously:` rename on a group or project
 * node as a single in-place update (`PUT /groups/:id` / `PUT /projects/:id`
 * with the new path), keeping the id, history, and memberships.
 *
 * This cycle is runner-managed, not registry-listed: the runner resolves each
 * node's `previously:` alias against live state before scope enumeration
 * (see `resolveNodeRenames` in `src/reconcile/runner.ts`), enumerates a
 * pending rename's scope under the OLD path, and appends this cycle after the
 * selected ones. The verified intents travel through a runner-composed
 * channel — the map handed to `makeNodeRenameCycle`, keyed by scope id — so
 * operator config never carries a rename intent (`NodeConfig` has no such
 * field to spoof). The ordering matters: every other cycle fetches and
 * applies against the old path (where the resource still lives), and the
 * rename lands last — the next run finds the node at its declared path and
 * the alias goes inert.
 *
 *   fetchLive    — nothing (the runner's alias probe was the read)
 *   buildDesired — the intent from the runner's rename map, plus the
 *                  display-name policy: `name` rides along ONLY when a
 *                  settings slice manages it and its value is available in
 *                  this run's config (`groupSettings.name` on group nodes).
 *                  Otherwise the PUT sends `path` alone — a curated display
 *                  name set by hand is never overwritten by a rename.
 *   apply        — one PUT against the old (live) path
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig } from "../config/types.js";
import type { ChangeSetEntry, DiffableNodeConfig, NodeRenameIntent } from "../reconcile/diff.js";
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

/**
 * Build the runner-appended node-rename cycle over the runner's verified
 * rename intents, keyed by (old-path) scope id. Scopes without an entry
 * no-op, so the cycle is inert everywhere but the renamed nodes.
 */
export function makeNodeRenameCycle(
  renames: ReadonlyMap<string, NodeRenameIntent>,
): Cycle<NodeRenameScope> {
  return {
    name: "node-rename",
    verb: "org-unit",

    // The runner already probed both paths while resolving the alias (that
    // probe is this cycle's read; a re-read here would double the requests
    // for no new information), so fetchLive returns nothing and the diff
    // shapes the intent as one update.
    async fetchLive(): Promise<LiveNodeState> {
      return {};
    },

    buildDesired(config: NodeConfig, scopeId: string): NodeConfig {
      const rename = renames.get(scopeId);
      if (!rename) return { kind: config.kind };
      // Display-name policy: send `name` only when a settings slice manages
      // it AND its value is available in this run's config — group nodes
      // with groupSettings.name. Everything else (projects, groups without a
      // managed name) renames by `path` alone, leaving the display name as
      // curated. This deliberately does not depend on which cycles were
      // selected this run: the value comes from the node's config, not from
      // the group-settings cycle having run.
      const managedName = config.kind === "group" ? config.groupSettings?.name : undefined;
      const intent: NodeRenameIntent =
        managedName !== undefined ? { ...rename, name: managedName } : { ...rename };
      const out: DiffableNodeConfig = { kind: config.kind, nodeRename: intent };
      return out;
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
}
