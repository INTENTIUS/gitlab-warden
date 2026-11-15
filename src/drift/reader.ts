/**
 * The drift reader for a forge-governance member (INTENTIUS/chant#5068,
 * INTENTIUS/gitlab-warden#74).
 *
 * `chant workspace drift --member <name>` calls the module `drift.reader`
 * names in workspace-kinds.json (`./entry.ts`), and the module calls
 * {@link readGovernanceDrift} here. It runs every cycle as a dry-run
 * reconcile (no write, ever) and turns the plan into one drift stream: a
 * `drift-start`, a `drift-record` per address and a `drift-settle`, the
 * answer `@intentius/chant/workspace/drift-reader` defines.
 *
 * Addresses are the graph reader's node ids (`./graph/reader.ts`), because
 * chant places a `warden` record on the member's graph by its address:
 * `team/<group path>`, `repo/<project path>`, `protection/<project
 * path>/<branch>` for a declared protected branch and `app/<path>/<name>`
 * for a declared integration. An instance node has no graph node and reads
 * as `instance/<path>`. Every planned change lands on one of them, so a
 * node's record lists each change under it as an attribute: `drifted` with
 * attributes when the plan changes anything there, `in-sync` when nothing,
 * and `not-observed` (reason `read-failed`) when a cycle errored at the node
 * or the request budget skipped a cycle (reason `not-reached`). A node that
 * drifted and also had a cycle fail is `drifted` with `attributesUnobserved`,
 * so an incomplete read never reads as no drift.
 */

import type { ChangeSetEntry } from "@intentius/chant/reconcile";
import {
  driftRecord,
  driftRecordLine,
  driftSettle,
  driftStart,
  type DriftAttribute,
  type DriftEvidence,
  type DriftExpected,
  type DriftRecord,
  type DriftUnobserved,
  type ReadDriftResult,
} from "@intentius/chant/drift-record";
import type { GitLabClient } from "../auth/client.js";
import type { GovernanceConfig, NodeConfig } from "../config/types.js";
import { parseScope, runReconcile, type Cycle } from "../reconcile/runner.js";

/** Who wrote the records, on every record and on the start line. */
export const DRIFT_TOOL = "gitlab-warden";

/**
 * Change-set resource types whose values can carry a secret (a variable's
 * value, a hook's URL or token, an integration's properties, key and token
 * material). Their attributes keep their path and lose both values.
 */
const SECRET_TYPES = new Set([
  "variable",
  "instance-variable",
  "webhook",
  "system-hook",
  "integration",
  "deploy-key",
  "deploy-token",
  "access-token",
]);

export interface GovernanceDriftInput {
  config: GovernanceConfig;
  client: GitLabClient;
  cycles: Cycle[];
  /** The workspace member every line names. */
  member: string;
  /** RFC 3339, every record's `observedAt`. */
  observedAt: string;
  /** One address to read (`--resource`): only its node's scope is reconciled. */
  resource?: string;
  /** The warden's version, for the records' evidence. */
  version?: string;
  requestBudget?: number;
}

/** One address the read expects: a declared node, or a protected branch or integration declared on one. */
interface Target {
  address: string;
  /** The declared node path it sits on. */
  path: string;
  resourceType: string;
  /** The graph node id, null for an instance node (the graph has none). */
  node: string | null;
}

/** The address of a declared node: its graph node id, or `instance/<path>`. */
export function nodeAddress(path: string, node: Pick<NodeConfig, "kind">): string {
  return node.kind === "group" ? `team/${path}` : node.kind === "project" ? `repo/${path}` : `instance/${path}`;
}

/** Every address the policy declares, in declaration order: each node, then its protected branches and integrations. */
export function driftTargets(config: GovernanceConfig): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  const add = (t: Target) => {
    if (seen.has(t.address)) return;
    seen.add(t.address);
    out.push(t);
  };
  for (const [path, node] of Object.entries(config.nodes ?? {})) {
    const graphed = node.kind === "group" || node.kind === "project";
    const address = nodeAddress(path, node);
    add({ address, path, resourceType: node.kind, node: graphed ? address : null });
    if (!graphed) continue;
    if (node.kind === "project") {
      for (const pb of node.protectedBranches ?? []) {
        if (typeof pb?.name === "string") add({ address: `protection/${path}/${pb.name}`, path, resourceType: "protected-branch", node: `protection/${path}/${pb.name}` });
      }
    }
    for (const app of node.integrations ?? []) {
      if (typeof app?.name === "string") add({ address: `app/${path}/${app.name}`, path, resourceType: "integration", node: `app/${path}/${app.name}` });
    }
  }
  return out;
}

/** The attribute path of a change: `member[#alice]`, `group-settings`, then `.field` for an update's fields. */
function entryPath(e: ChangeSetEntry): string {
  return e.key === e.resourceType ? e.resourceType : `${e.resourceType}[#${e.key}]`;
}

/**
 * A planned change as drift attributes. `before` is what the policy declares
 * and `after` what GitLab holds, as a drift record reads them: an update gives
 * one attribute per field, a create the declared value with nothing live, a
 * delete the live value with nothing declared.
 */
export function entryAttributes(e: ChangeSetEntry): DriftAttribute[] {
  const base = entryPath(e);
  const secret = SECRET_TYPES.has(e.resourceType);
  const attr = (path: string, declared: unknown, live: unknown): DriftAttribute =>
    secret
      ? { path, sensitive: true }
      : { path, ...(declared !== undefined ? { before: declared } : {}), ...(live !== undefined ? { after: live } : {}) };
  if (e.kind === "update" && e.fields && e.fields.length > 0) return e.fields.map((f) => attr(`${base}.${f.field}`, f.after, f.before));
  if (e.kind === "create") return [attr(base, e.after, undefined)];
  if (e.kind === "delete") return [attr(base, undefined, e.before)];
  return [attr(base, e.after, e.before)];
}

/** The declared path a scope id stands for: the scope's own path, or the node whose `previously:` it is during a pending rename. */
function declaredPath(config: GovernanceConfig, scopeId: string): string {
  const { path } = parseScope(scopeId);
  if (config.nodes[path] !== undefined) return path;
  const renamed = Object.entries(config.nodes).find(([, n]) => n.previously === path);
  return renamed ? renamed[0] : path;
}

/** The target a change lands on: its own protected-branch or integration node when declared, else its node. */
function targetFor(byAddress: Map<string, Target>, path: string, e: ChangeSetEntry, nodeAddr: string): string {
  if (e.resourceType === "protected-branch" && byAddress.has(`protection/${path}/${e.key}`)) return `protection/${path}/${e.key}`;
  if (e.resourceType === "integration" && byAddress.has(`app/${path}/${e.key}`)) return `app/${path}/${e.key}`;
  return nodeAddr;
}

/**
 * Read the member's drift: a dry-run reconcile of every cycle, as one drift
 * stream. Refuses `no-drift-read` for a `--resource` the policy does not
 * declare. Throws what the reconcile throws before any cycle runs (an invalid
 * `previously:`), which chant reports as a failed read.
 */
export async function readGovernanceDrift(input: GovernanceDriftInput): Promise<ReadDriftResult> {
  const { member, observedAt } = input;
  let targets = driftTargets(input.config);
  let config = input.config;
  if (input.resource !== undefined) {
    const t = targets.find((x) => x.address === input.resource);
    if (!t) {
      return { refused: { code: "no-drift-read", message: `${input.resource} is not a node, protected branch or integration the policy declares; the addresses are ${targets.map((x) => x.address).join(", ") || "(none)"}` } };
    }
    targets = [t];
    config = { ...input.config, nodes: { [t.path]: input.config.nodes[t.path] } };
  }
  const byAddress = new Map(targets.map((t) => [t.address, t]));
  const nodeAddrByPath = new Map(Object.entries(config.nodes).map(([p, n]) => [p, nodeAddress(p, n)]));

  const result = await runReconcile({ config, client: input.client, cycles: input.cycles, mode: "dry-run", requestBudget: input.requestBudget });

  const attributes = new Map<string, DriftAttribute[]>();
  for (const cs of result.changeSets) {
    const path = declaredPath(config, cs.org);
    const nodeAddr = nodeAddrByPath.get(path);
    if (nodeAddr === undefined) continue;
    for (const e of cs.entries) {
      const at = targetFor(byAddress, path, e, nodeAddr);
      if (!byAddress.has(at)) continue;
      const list = attributes.get(at) ?? [];
      list.push(...entryAttributes(e));
      attributes.set(at, list);
    }
  }

  // Why an address could not be read in full. A cycle error marks its node
  // and everything declared on it; a cycle the budget skipped marks every
  // address, since it ran for no scope.
  const failed = new Map<string, string[]>();
  const note = (address: string, why: string) => failed.set(address, [...(failed.get(address) ?? []), why]);
  for (const e of result.errored) {
    const path = declaredPath(config, e.org);
    const why = `${e.name} errored in ${e.stage}: ${e.error}`;
    const on = targets.filter((t) => t.path === path);
    // An error at a scope the targets don't name still makes the read incomplete.
    for (const t of on.length > 0 ? on : targets) note(t.address, why);
  }
  const skipped = result.deferred.skippedCycles;

  const evidence: DriftEvidence = { tool: DRIFT_TOOL, ...(input.version ? { version: input.version } : {}), command: "reconcile --mode dry-run" };
  const unobservedOf = (address: string): DriftUnobserved | undefined => {
    const errors = failed.get(address);
    if (errors) return { reason: "read-failed", detail: errors.join("; ") };
    if (skipped.length > 0) return { reason: "not-reached", detail: `${skipped.join(", ")} deferred by the request budget` };
    return undefined;
  };

  const records: DriftRecord[] = targets.map((t) => {
    const attrs = attributes.get(t.address) ?? [];
    const unobserved = unobservedOf(t.address);
    const head = { member, engine: "warden" as const, address: t.address, resourceType: t.resourceType, node: t.node, observedAt, read: "live-read" as const, evidence };
    if (attrs.length > 0) return driftRecord({ ...head, status: "drifted", attributes: attrs, ...(unobserved ? { attributesUnobserved: unobserved } : {}) });
    if (unobserved) return driftRecord({ ...head, status: "not-observed", unobserved });
    return driftRecord({ ...head, status: "in-sync" });
  });

  const expected: DriftExpected[] = targets.map((t) => ({ address: t.address, node: t.node, resourceType: t.resourceType }));
  const start = driftStart({
    member,
    engine: "warden",
    read: "live-read",
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    at: observedAt,
    expected,
    evidence,
  });
  const settled = driftSettle(start, records, observedAt);
  return { lines: [start, ...settled.records.map(driftRecordLine), settled.line] };
}
