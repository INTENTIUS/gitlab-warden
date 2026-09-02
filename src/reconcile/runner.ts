/**
 * GitLab reconcile runner.
 *
 * A thin adapter over the provider-agnostic `runReconcile` / `Cycle` harness in
 * `@intentius/chant/reconcile` — it wires GitLab's `diff` and a GitLab-
 * appropriate guardrail set into the shared loop, and re-exports the harness
 * types so cycles import them from here.
 *
 * Scope ids are **kind-prefixed** — `"group:acme/platform"` /
 * `"project:acme/platform/api"` — so a cycle's `fetchLive`/`apply` (which only
 * receive the scope id) know whether to hit group or project endpoints. Use
 * `parseScope()` to split one and `encodeId()` (from the client) on the path.
 *
 * `previously:` node aliases resolve here, before scope enumeration (see
 * `resolveNodeRenames`): a pending rename's scope runs under the OLD path for
 * the whole run and the appended `node-rename` cycle applies the rename last.
 *
 * Guardrails: the removal cap (don't let a typo mass-delete), evaluated PER
 * RESOURCE TYPE against the LIVE roster — `diff()` stamps per-type live counts
 * on the change set (`ChangeSet.managedCounts`) and chant's `removalDeltaCap`
 * reads them, so live entries of one type cannot dilute a wipe of another. A
 * self-lockout guard (don't strip the last Owner) can be layered in once the
 * members cycle lands.
 */

import {
  runReconcile as coreRunReconcile,
  runGuardrailChecks,
  removalDeltaCap,
} from "@intentius/chant/reconcile";
import type {
  Cycle as CoreCycle,
  ReconcileResult,
  DiffOptions,
} from "@intentius/chant/reconcile";
import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { GovernanceConfig, NodeConfig, NodeKind } from "../config/types.js";
import type { LiveNodeState } from "./live.js";
import { diff } from "./diff.js";
import { drainGatedSliceNotes, isNotFound } from "../cycles/_shared.js";
import { nodeRenameCycle } from "../cycles/node-rename.js";

export { BudgetExhaustedError } from "@intentius/chant/reconcile";
export type {
  RateBudget,
  CycleResult,
  CycleError,
  DeferredWork,
  ReconcileResult,
} from "@intentius/chant/reconcile";

/** A GitLab governance cycle — the shared `Cycle` specialized to warden's types. */
export type Cycle<TScope = unknown> = CoreCycle<GitLabClient, NodeConfig, LiveNodeState, TScope>;

/** A node's kind + full path, parsed from a scope id. */
export interface ParsedNode {
  kind: NodeKind;
  path: string;
}

/** Build a kind-prefixed scope id from a node's kind + full path. */
export function nodeScopeId(kind: NodeKind, path: string): string {
  return `${kind}:${path}`;
}

/** Split a kind-prefixed scope id into its kind and full path. */
export function parseScope(scopeId: string): ParsedNode {
  const i = scopeId.indexOf(":");
  const kind = scopeId.slice(0, i) as NodeKind;
  return { kind, path: scopeId.slice(i + 1) };
}

/** Options for warden's `runReconcile` (config-based). */
export interface RunReconcileOptions<TScope = unknown> {
  config: GovernanceConfig;
  client: GitLabClient;
  cycles: Cycle<TScope>[];
  scope?: TScope;
  mode?: "dry-run" | "apply";
  diffOptions?: DiffOptions;
  allowGuardrailOverride?: boolean;
  requestBudget?: number;
  /** Max fraction of pre-existing entries deletable in one apply. Default 0.25. */
  removalDeltaCapFraction?: number;
}

/** A pending node rename, resolved from a node's `previously:` alias. */
export interface PendingNodeRename {
  kind: NodeKind;
  /** Live full path (the alias). */
  fromPath: string;
  /** Declared full path (the node's key in `nodes{}`). */
  toPath: string;
}

/** Parent namespace of a full path ("" for a top-level path). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Whether a group/project exists at `path` (404 → no; other errors rethrow). */
async function nodeIsLive(client: GitLabClient, kind: NodeKind, path: string): Promise<boolean> {
  try {
    await client.request("GET", `/${kind === "group" ? "groups" : "projects"}/${encodeId(path)}`);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Resolve each node's `previously:` alias against live state, BEFORE scope
 * enumeration — scope ids are kind-prefixed full paths built from node keys,
 * so a rename must be known before the node map becomes scopes. An alias is a
 * pending rename only when the live resource exists at the old path and none
 * exists at the declared path; a declared path that is already live wins (the
 * alias is inert), and an alias with nothing live at either path is a no-op
 * falling back to normal create behavior. The 1-2 probe GETs per aliased node
 * run before the request budget exists and are not charged against it.
 *
 * Config errors (an alias on an instance node, a cross-namespace alias — a
 * transfer, not a rename — or an alias colliding with another declared node)
 * throw rather than guess.
 */
export async function resolveNodeRenames(
  client: GitLabClient,
  nodes: Record<string, NodeConfig>,
): Promise<PendingNodeRename[]> {
  const pending: PendingNodeRename[] = [];
  const seenAliases = new Set<string>();
  for (const [path, node] of Object.entries(nodes)) {
    const prev = node.previously;
    if (typeof prev !== "string" || prev === path) continue;
    if (node.kind === "instance") {
      throw new Error(`node "${path}": previously: is not supported on instance nodes`);
    }
    if (parentOf(prev) !== parentOf(path)) {
      throw new Error(
        `node "${path}": previously: "${prev}" is in a different parent namespace — ` +
          `previously: declares a rename, not a transfer`,
      );
    }
    if (nodes[prev] !== undefined) {
      throw new Error(`node "${path}": previously: "${prev}" is itself a declared node`);
    }
    if (seenAliases.has(prev)) {
      throw new Error(`previously: "${prev}" is declared by more than one node`);
    }
    seenAliases.add(prev);
    if (await nodeIsLive(client, node.kind, path)) continue; // declared path live → alias inert
    if (!(await nodeIsLive(client, node.kind, prev))) continue; // nothing to adopt → normal create path
    pending.push({ kind: node.kind, fromPath: prev, toPath: path });
  }
  return pending;
}

/**
 * Ownership predicate for one node, derived from its `owned` declaration:
 * `true` owns every reconciled collection, a string array owns only the listed
 * resource types, absent/`false` owns nothing (no deletes planned). Returns
 * `undefined` for the latter so the diff's "no predicate → no deletes" default
 * applies unchanged.
 */
function ownedPredicate(owned: NodeConfig["owned"]): DiffOptions["isOwned"] {
  if (owned === undefined || owned === false) return undefined;
  return (type: string) => owned === true || (Array.isArray(owned) && owned.includes(type));
}

/**
 * Run the GitLab governance reconcile loop, delegating to the shared runner with
 * warden's `diff` (kind-prefixed node id as scope id) and guardrails wired in.
 *
 * Deletes: per scope, a caller-supplied `diffOptions.isOwned` wins; otherwise
 * the predicate is derived from that node's `owned` declaration (see
 * `NodeConfig.owned`). Guardrails (`removalDeltaCap`) apply either way.
 * `diff()` stamps per-type live counts on the change set
 * (`ChangeSet.managedCounts`) and the cap evaluates each resource type
 * against its own live denominator: a converged cycle's one stale delete
 * reads as 1/N of that type's live roster, not 1/1 of the plan, while live
 * entries of another type cannot dilute a wipe. A type with no live count
 * keeps chant's per-type plan-relative behavior, so nothing gets less safe.
 */
export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  const maxFraction = opts.removalDeltaCapFraction ?? 0.25;

  // Resolve `previously:` aliases first — scopes are built from node keys, so
  // a pending rename must be known before the node map becomes scopes.
  const pendingRenames = await resolveNodeRenames(opts.client, opts.config.nodes);
  const renameByPath = new Map(pendingRenames.map((p) => [p.toPath, p]));

  // Map declared nodes (keyed by full path) → kind-prefixed reconcile scopes.
  // A node with a pending rename is adopted under its OLD path — the live
  // identity — so every cycle reads and writes the resource where it actually
  // lives, with the verified intent injected as the `nodeRename` slice. The
  // rename itself is applied by `nodeRenameCycle`, appended LAST below:
  // chant's loop is cycle-major, so all other cycles finish against the old
  // path before the rename PUT moves it; the next run finds the node at its
  // declared path and the alias goes inert. (`nodeRename` is runner-owned:
  // any operator-written value is dropped here.)
  const scopes: Record<string, NodeConfig> = {};
  for (const [path, node] of Object.entries(opts.config.nodes)) {
    const p = renameByPath.get(path);
    if (p) {
      scopes[nodeScopeId(node.kind, p.fromPath)] = { ...node, nodeRename: { fromPath: p.fromPath, toPath: path } };
    } else {
      scopes[nodeScopeId(node.kind, path)] = { ...node, nodeRename: undefined };
    }
  }

  const cycles =
    pendingRenames.length > 0 && !opts.cycles.some((c) => c.name === nodeRenameCycle.name)
      ? [...opts.cycles, nodeRenameCycle as unknown as Cycle<TScope>]
      : opts.cycles;

  // Clear notes a previous (crashed/errored) run may have left behind.
  drainGatedSliceNotes();

  const result = await coreRunReconcile<GitLabClient, NodeConfig, LiveNodeState, TScope>({
    client: opts.client,
    scopes,
    cycles,
    scope: opts.scope,
    mode: opts.mode,
    diff: (scopeId, desired, live, dopts) => {
      // Per-scope ownership: the scope id keys straight into `scopes` (it was
      // built above from the same node map), so resolve the node's `owned`
      // declaration from there — `desired` is a cycle's buildDesired output
      // and may not carry it.
      const isOwned = dopts.isOwned ?? ownedPredicate(scopes[scopeId]?.owned);
      return diff(scopeId, desired, live, { ...dopts, isOwned });
    },
    // The change set carries its own per-type live denominators
    // (`managedCounts`, stamped by `diff()`), so the cap needs only the
    // fraction — passing a managedTotal here would shadow the per-type counts.
    guardrails: (changeSet) =>
      runGuardrailChecks(changeSet, [(resolved) => removalDeltaCap(resolved, { maxFraction })]),
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });

  // Surface tier-gated reads (recorded by cycles during fetchLive) as NOTE
  // lines on the owning cycle's plan — an optimistic create for a slice the
  // token couldn't read should not look like a clean plan.
  for (const note of drainGatedSliceNotes()) {
    const cr = result.cycles.find((c) => c.name === note.cycle && c.org === note.scopeId);
    if (cr) {
      cr.plan += `\nNOTE: ${note.slice}: read was tier-gated (403); planned entries may fail on apply`;
    }
  }

  return result;
}
