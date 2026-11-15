/**
 * The drift reader for a forge-governance member (INTENTIUS/chant#5068,
 * INTENTIUS/gitlab-warden#74).
 *
 * `chant workspace drift --member <name>` imports `dist/drift-reader.mjs`
 * (`./entry.ts`) for a member of the `forge-governance` kind and calls it
 * with the member's directory. The reader loads the member's policy, runs
 * every registered cycle in dry-run against GitLab, and answers with drift
 * stream lines: a start naming every node the policy declares, one record
 * per node, and a settle. It never applies anything. The shape is
 * forgejo-warden's and github-warden's.
 *
 * A record is one node, addressed by the graph reader's id
 * (`../graph/reader.ts`), since chant places a `warden` record by its address:
 * `team/<group path>`, `repo/<project path>`, `protection/<project
 * path>/<branch>` and `app/<path>/<integration>`. An instance node has no
 * graph node and reads as `instance/<path>`. A node is `in-sync` when no
 * planned change falls under it and `drifted` when some do, each planned
 * change one attribute. A change under a node the graph does not draw (an
 * owned protected branch or integration the policy does not declare) is a
 * record of its own with no node.
 *
 * `reconcile --drift-issue` builds its records with {@link governanceDrift}
 * too, so the drift issue and `chant workspace drift` report the same thing.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  driftRecord,
  driftRecordLine,
  driftSettle,
  driftStart,
  type DriftAttribute,
  type DriftEvidence,
  type DriftLine,
  type DriftRecord,
  type DriftStartLine,
  type DriftUnobserved,
} from "@intentius/chant/drift-record";
import type { DriftReaderInput, DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import type { ChangeSet, ChangeSetEntry, CycleError, DeferredWork } from "@intentius/chant/reconcile";
import { createClient, DEFAULT_BASE_URL, type GitLabClient } from "../auth/client.js";
import { CYCLE_REGISTRY } from "../cli/registry.js";
import { loadGovernancePolicy } from "../config/load.js";
import { deprecationNote, POLICY_FILE, resolvePolicyPath, TS_POLICY_FILE } from "../config/policy-path.js";
import type { GovernanceConfig, NodeKind } from "../config/types.js";
import { readGovernance } from "../graph/reader.js";
import { parseScope, runReconcile, type Cycle } from "../reconcile/runner.js";
import pkg from "../../package.json" with { type: "json" };

/** The engine a warden's records name. */
export const DRIFT_ENGINE = "warden" as const;
/** The read a warden answers: its own read of GitLab, compared with the policy. */
export const DRIFT_READ = "live-read" as const;
/** The env vars the reader takes its credentials from, unless the kind's config names others. */
export const DEFAULT_TOKEN_ENV = "GITLAB_TOKEN";
export const DEFAULT_BASE_URL_ENV = "GITLAB_BASE_URL";

/** What every record and the start line say produced them. */
export function driftEvidence(): DriftEvidence {
  return { tool: "gitlab-warden", version: pkg.version, command: "reconcile --mode dry-run" };
}

/**
 * Change-set resource types whose values can carry a secret (a variable's
 * value, a hook's URL or token, an integration's properties, key and token
 * material): their attributes keep the path and carry no values.
 */
const SENSITIVE_TYPES = new Set(["variable", "instance-variable", "webhook", "system-hook", "integration", "deploy-key", "deploy-token", "access-token"]);

/** A declared node's id: the graph reader's for a group or project, `instance/<path>` for an instance. */
export function nodeAddress(kind: NodeKind, path: string): string {
  return kind === "group" ? `team/${path}` : kind === "project" ? `repo/${path}` : `instance/${path}`;
}

/**
 * The node a planned change falls under. A protected branch and an
 * integration are graph nodes of their own; everything else a cycle plans
 * for a group, project or instance (settings, members, variables, hooks, a
 * rename) goes on that node.
 */
export function driftAddress(kind: NodeKind, path: string, entry: Pick<ChangeSetEntry, "resourceType" | "key">): string {
  switch (entry.resourceType) {
    case "protected-branch":
      return `protection/${path}/${entry.key}`;
    case "integration":
      return `app/${path}/${entry.key}`;
    default:
      return nodeAddress(kind, path);
  }
}

/**
 * A planned change as attributes, in the drift record's direction (`before`
 * the declared value, `after` the live one): an update gives one per field
 * (`member[#alice].accessLevel`, `group-settings.visibility` for a
 * single-object slice), a create its declared value, a delete its live one.
 */
export function driftAttributes(entry: ChangeSetEntry): DriftAttribute[] {
  const base = entry.key === entry.resourceType ? entry.resourceType : `${entry.resourceType}[#${entry.key}]`;
  const sensitive = SENSITIVE_TYPES.has(entry.resourceType);
  const attr = (path: string, before: unknown, after: unknown): DriftAttribute =>
    sensitive
      ? { path, sensitive: true }
      : { path, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
  if (entry.kind === "update" && entry.fields?.length) return entry.fields.map((f) => attr(`${base}.${f.field}`, f.after, f.before));
  if (entry.kind === "delete") return [attr(base, undefined, entry.before)];
  return [attr(base, entry.after, undefined)];
}

/** A node the policy declares: its address and the declared node path it sits on. */
export interface DeclaredNode {
  address: string;
  path: string;
}

/**
 * The nodes the policy declares, in the graph reader's order: each group,
 * project, protected branch and integration, then each instance node. The
 * graph's `org/<namespace>` nodes are left out: no cycle reads a namespace
 * apart from its declared group, so the read could not say one is in sync.
 */
export function declaredNodes(policy: GovernanceConfig): DeclaredNode[] {
  const graph = readGovernance(policy);
  const pathOf = new Map<string, string>();
  for (const [path, node] of Object.entries(policy.nodes ?? {})) pathOf.set(nodeAddress(node.kind, path), path);
  // A protected branch or integration sits on the node its edge points at.
  for (const e of graph.edges) if (e.viaAttr === "protectedBranches" || e.viaAttr === "integration") pathOf.set(e.from, pathOf.get(e.to)!);
  const out: DeclaredNode[] = [];
  for (const n of graph.nodes) {
    const path = pathOf.get(n.id);
    if (n.kind !== "Org" && path !== undefined) out.push({ address: n.id, path });
  }
  for (const [path, node] of Object.entries(policy.nodes ?? {})) {
    if (node.kind === "instance") out.push({ address: nodeAddress("instance", path), path });
  }
  return out;
}

/** The declared path a scope id stands for: the scope's own path, or the node whose `previously:` it is during a pending rename. */
function declaredPath(policy: GovernanceConfig, scopeId: string): string {
  const { path } = parseScope(scopeId);
  if (policy.nodes[path] !== undefined) return path;
  const renamed = Object.entries(policy.nodes).find(([, n]) => n.previously === path);
  return renamed ? renamed[0] : path;
}

export interface GovernanceDriftInput {
  member: string;
  /** RFC 3339, given to every record. */
  observedAt: string;
  /** The policy the run reconciled, for the nodes it declares. */
  policy: GovernanceConfig;
  /** Every change set the run diffed, one per cycle and scope. */
  changeSets: readonly ChangeSet[];
  /** Cycles that failed before they could plan. */
  errored?: readonly CycleError[];
  /** Cycles the request budget skipped. */
  deferred?: DeferredWork;
  /** One node to read alone (`--resource`); its record is the only one. */
  resource?: string;
}

/**
 * The read as a start line and its records: every declared node in-sync,
 * drifted (each planned change under it an attribute) or not-observed (a
 * cycle errored at its node, or the budget deferred one).
 */
export function governanceDrift(input: GovernanceDriftInput): { start: DriftStartLine; records: DriftRecord[] } {
  const evidence = driftEvidence();
  const base = { member: input.member, engine: DRIFT_ENGINE, node: null, observedAt: input.observedAt, read: DRIFT_READ, evidence };
  const nodes = declaredNodes(input.policy);
  const declared = nodes.map((n) => n.address);
  const pathOf = new Map(nodes.map((n) => [n.address, n.path] as const));

  const attributes = new Map<string, DriftAttribute[]>();
  for (const cs of input.changeSets) {
    const path = declaredPath(input.policy, cs.org);
    const kind = input.policy.nodes[path]?.kind ?? parseScope(cs.org).kind;
    for (const entry of cs.entries) {
      const address = driftAddress(kind, path, entry);
      if (!pathOf.has(address)) pathOf.set(address, path);
      attributes.set(address, [...(attributes.get(address) ?? []), ...driftAttributes(entry)]);
    }
  }

  // A cycle error marks its node and what is declared on it. One at a scope
  // no address sits on still leaves the read incomplete, so it marks them all.
  const failedIn = new Map<string, string[]>();
  const everywhere: string[] = [];
  const paths = new Set(pathOf.values());
  for (const e of input.errored ?? []) {
    const path = declaredPath(input.policy, e.org);
    const why = `${e.name} errored in ${e.stage}: ${e.error}`;
    if (paths.has(path)) failedIn.set(path, [...(failedIn.get(path) ?? []), why]);
    else everywhere.push(why);
  }
  const deferred = input.deferred?.skippedCycles ?? [];
  const deferredWhy: DriftUnobserved | undefined = deferred.length
    ? { reason: "not-reached", detail: `deferred by the request budget: ${deferred.join(", ")}` }
    : undefined;

  const addresses = [...new Set([...declared, ...attributes.keys()])].filter((a) => input.resource === undefined || a === input.resource);
  const records = addresses.map((address) => {
    const attrs = attributes.get(address);
    const failed = [...(failedIn.get(pathOf.get(address) ?? "") ?? []), ...everywhere];
    const unobserved: DriftUnobserved | undefined = deferredWhy ?? (failed.length ? { reason: "read-failed", detail: failed.join("; ") } : undefined);
    if (unobserved && (deferredWhy || !attrs)) return driftRecord({ ...base, address, status: "not-observed", unobserved });
    if (attrs) return driftRecord({ ...base, address, status: "drifted", attributes: attrs, ...(unobserved ? { attributesUnobserved: unobserved } : {}) });
    return driftRecord({ ...base, address, status: "in-sync" });
  });

  const start = driftStart({
    member: input.member,
    engine: DRIFT_ENGINE,
    read: DRIFT_READ,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    at: input.observedAt,
    expected: input.resource !== undefined ? [input.resource] : declared,
    evidence,
  });
  return { start, records };
}

/** The stream for one read: start, the records, settle. */
export function driftLines(start: DriftStartLine, records: readonly DriftRecord[], at: string): DriftLine[] {
  const settled = driftSettle(start, records, at);
  return [start, ...settled.records.map(driftRecordLine), settled.line];
}

export interface ReadGovernanceDriftDeps {
  /** The environment credentials come from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Builds the GitLab client. Default {@link createClient}. */
  createClient?: (opts: { baseUrl: string; token: string }) => GitLabClient;
  /** The cycles to run. Default every registered cycle. */
  cycles?: Cycle[];
  /** The request budget. Default the runner's. */
  requestBudget?: number;
}

const refuse = (code: "read-unsupported" | "no-drift-read", message: string): DriftReaderOutput => ({ refused: { code, message } });

const configString = (config: Record<string, unknown>, key: string, fallback: string): string => {
  const v = config[key];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
};

/**
 * The member's policy: the kind's `file` in its directory, then
 * `governance.yaml` beside it (with a deprecation note on stderr), then
 * `governance.ts`. Undefined when none exists.
 */
function memberPolicy(dir: string, file: string): string | undefined {
  const found = resolvePolicyPath(join(dir, file));
  if (found && existsSync(found.path)) {
    if (found.deprecated) process.stderr.write(deprecationNote(found.path));
    return found.path;
  }
  const ts = join(dirname(join(dir, file)), TS_POLICY_FILE);
  return existsSync(ts) ? ts : undefined;
}

/**
 * Read a forge-governance member's drift. Refuses, without throwing, a read
 * or stack it does not have, a missing token or policy, and a `--resource`
 * the policy does not declare. A policy that does not load throws, which
 * chant reports as a failed read.
 */
export async function readGovernanceDrift(input: DriftReaderInput, deps: ReadGovernanceDriftDeps = {}): Promise<DriftReaderOutput> {
  if (input.read !== undefined && input.read !== DRIFT_READ) {
    return refuse("read-unsupported", `gitlab-warden answers the ${DRIFT_READ} read only (a reconcile dry run), not ${input.read}`);
  }
  if (input.stack !== undefined) return refuse("read-unsupported", "gitlab-warden has no stacks; a governance member is read whole");

  const env = deps.env ?? process.env;
  const config = input.config ?? {};
  const tokenEnv = configString(config, "tokenEnv", DEFAULT_TOKEN_ENV);
  const baseUrlEnv = configString(config, "baseUrlEnv", DEFAULT_BASE_URL_ENV);
  const token = env[tokenEnv]?.trim();
  if (!token) return refuse("no-drift-read", `${tokenEnv} is not set; gitlab-warden reads its GitLab API token from it to read ${input.member}'s drift`);
  // GitLab has a default instance, so an unset base URL is gitlab.com, as for the CLI.
  const baseUrl = env[baseUrlEnv]?.trim() || DEFAULT_BASE_URL;

  const dir = resolve(input.dir);
  const file = configString(config, "file", POLICY_FILE);
  const path = memberPolicy(dir, file);
  if (!path) return refuse("no-drift-read", `${input.member} has no governance policy: neither ${join(dir, file)} nor governance.yaml or governance.ts exists`);
  const { config: policy } = await loadGovernancePolicy(path, "fold");

  let scope = policy;
  if (input.resource !== undefined) {
    const node = declaredNodes(policy).find((n) => n.address === input.resource);
    if (node === undefined) return refuse("no-drift-read", `${input.member}'s policy declares no ${input.resource}`);
    // A node's drift is its declared node's: reconcile that node alone.
    scope = { ...policy, nodes: { [node.path]: policy.nodes[node.path] } };
  }

  const client = (deps.createClient ?? createClient)({ baseUrl, token });
  const result = await runReconcile({
    config: scope,
    client,
    cycles: deps.cycles ?? Object.values(CYCLE_REGISTRY),
    mode: "dry-run",
    ...(deps.requestBudget !== undefined ? { requestBudget: deps.requestBudget } : {}),
  });
  const { start, records } = governanceDrift({
    member: input.member,
    observedAt: input.observedAt,
    policy: scope,
    changeSets: result.changeSets,
    errored: result.errored,
    deferred: result.deferred,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
  });
  return { lines: driftLines(start, records, input.observedAt) };
}
