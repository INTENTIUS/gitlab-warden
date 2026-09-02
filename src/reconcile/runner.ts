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
 * Guardrails: the removal cap (don't let a typo mass-delete). A self-lockout
 * guard (don't strip the last Owner) can be layered in once the members cycle
 * lands.
 */

import {
  runReconcile as coreRunReconcile,
  runGuardrailChecks,
  removalDeltaCap,
} from "@intentius/chant/reconcile";
import type { Cycle as CoreCycle, ReconcileResult, DiffOptions } from "@intentius/chant/reconcile";
import type { GitLabClient } from "../auth/client.js";
import type { GovernanceConfig, NodeConfig, NodeKind } from "../config/types.js";
import type { LiveNodeState } from "./live.js";
import { diff } from "./diff.js";

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
 */
export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  const maxFraction = opts.removalDeltaCapFraction ?? 0.25;

  // Map declared nodes (keyed by full path) → kind-prefixed reconcile scopes.
  const scopes: Record<string, NodeConfig> = {};
  for (const [path, node] of Object.entries(opts.config.nodes)) {
    scopes[nodeScopeId(node.kind, path)] = node;
  }

  return coreRunReconcile<GitLabClient, NodeConfig, LiveNodeState, TScope>({
    client: opts.client,
    scopes,
    cycles: opts.cycles,
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
    guardrails: (changeSet) =>
      runGuardrailChecks(changeSet, [(resolved) => removalDeltaCap(resolved, { maxFraction })]),
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });
}
