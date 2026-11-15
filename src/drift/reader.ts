/**
 * The drift reader for a forge-governance member (INTENTIUS/chant#5068,
 * INTENTIUS/gitlab-warden#74).
 *
 * `chant workspace drift --member <name>` imports `dist/drift-reader.mjs`
 * (`./entry.ts`) for a member of the `forge-governance` kind and calls it
 * with the member's directory. The reader loads the member's policy, runs
 * every registered cycle in dry-run against GitLab, and turns the planned
 * changes into drift stream lines: a start, one record per planned change,
 * and a settle. It never applies anything. The shape is forgejo-warden's
 * (forgejo-warden#46), with GitLab's addresses.
 *
 * `reconcile --drift-issue` builds its records with {@link driftRecords}
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
  type DriftStatus,
} from "@intentius/chant/drift-record";
import type { DriftReaderInput, DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import type { ChangeSet, ChangeSetEntry, CycleError, DeferredWork } from "@intentius/chant/reconcile";
import { createClient, DEFAULT_BASE_URL, type GitLabClient } from "../auth/client.js";
import { CYCLE_REGISTRY } from "../cli/registry.js";
import { loadGovernancePolicy } from "../config/load.js";
import { deprecationNote, POLICY_FILE, resolvePolicyPath, TS_POLICY_FILE } from "../config/policy-path.js";
import type { GovernanceConfig } from "../config/types.js";
import { parseScope, runReconcile, type Cycle } from "../reconcile/runner.js";
import pkg from "../../package.json" with { type: "json" };

/** The engine a warden's records name. */
export const DRIFT_ENGINE = "warden" as const;
/** The read a warden answers: its reconcile plan, what the next apply would change. */
export const DRIFT_READ = "plan" as const;
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
 * material). chant redacts by key name only, and `value` is not one of its
 * names, so an update's attributes of these types keep the path and lose
 * both values.
 */
const SECRET_TYPES = new Set(["variable", "instance-variable", "webhook", "system-hook", "integration", "deploy-key", "deploy-token", "access-token"]);

/**
 * A planned change's drift address: the declared node's full path, and the
 * graph reader's node id (`../graph/reader.ts`) for the types it draws, so
 * chant places the record on that node. `path` is the node's declared path
 * (during a pending rename, the new one).
 */
export function driftAddress(path: string, entry: Pick<ChangeSetEntry, "resourceType" | "key">): string {
  switch (entry.resourceType) {
    case "group-settings":
      return `team/${path}`;
    case "project-settings":
      return `repo/${path}`;
    case "protected-branch":
      return `protection/${path}/${entry.key}`;
    case "integration":
      return `app/${path}/${entry.key}`;
    case "node":
      return `node/${path}`;
    default:
      return entry.key === entry.resourceType ? `${entry.resourceType}/${path}` : `${entry.resourceType}/${path}/${entry.key}`;
  }
}

const STATUS_BY_KIND: Record<ChangeSetEntry["kind"], DriftStatus> = {
  // Declared and absent on GitLab.
  create: "pending",
  // Present, and a declared field differs.
  update: "drifted",
  // On GitLab, in an owned collection, and not declared.
  delete: "undeclared",
};

/** The declared path a scope id stands for: the scope's own path, or the node whose `previously:` it is during a pending rename. */
function declaredPath(policy: GovernanceConfig | undefined, scopeId: string): string {
  const { path } = parseScope(scopeId);
  if (!policy || policy.nodes[path] !== undefined) return path;
  const renamed = Object.entries(policy.nodes).find(([, n]) => n.previously === path);
  return renamed ? renamed[0] : path;
}

export interface DriftRecordsInput {
  member: string;
  /** RFC 3339, given to every record. */
  observedAt: string;
  /** Every change set the run diffed, one per cycle and scope. */
  changeSets: readonly ChangeSet[];
  /** Cycles that failed before they could plan. */
  errored?: readonly CycleError[];
  /** Cycles the request budget skipped. */
  deferred?: DeferredWork;
  /** The policy the run reconciled, to name a renamed node by its declared path. */
  policy?: GovernanceConfig;
}

/**
 * The run's drift records: one per planned change, and a `not-observed`
 * record for each cycle that errored or was deferred, so an incomplete read
 * never reads as clean. A later record at the same address replaces an
 * earlier one.
 */
export function driftRecords(input: DriftRecordsInput): DriftRecord[] {
  const evidence = driftEvidence();
  const base = { member: input.member, engine: DRIFT_ENGINE, node: null, observedAt: input.observedAt, read: DRIFT_READ };
  const byAddress = new Map<string, DriftRecord>();
  const put = (r: DriftRecord) => byAddress.set(r.address, driftRecord(r));

  for (const cs of input.changeSets) {
    const path = declaredPath(input.policy, cs.org);
    for (const entry of cs.entries) {
      const status = STATUS_BY_KIND[entry.kind];
      const secret = SECRET_TYPES.has(entry.resourceType);
      // The drift record's direction: `before` is what was expected (the
      // policy), `after` what the read found (GitLab).
      const attributes: DriftAttribute[] | undefined =
        status === "drifted" && entry.fields?.length
          ? entry.fields.map((f) =>
              secret
                ? { path: f.field, sensitive: true as const }
                : { path: f.field, ...(f.after !== undefined ? { before: f.after } : {}), ...(f.before !== undefined ? { after: f.before } : {}) },
            )
          : undefined;
      put({
        ...base,
        address: driftAddress(path, entry),
        resourceType: entry.resourceType,
        status,
        ...(attributes ? { attributes } : {}),
        evidence: { ...evidence, engineCode: entry.kind },
      });
    }
  }
  for (const e of input.errored ?? []) {
    put({
      ...base,
      address: `cycle/${declaredPath(input.policy, e.org)}/${e.name}`,
      status: "not-observed",
      unobserved: { reason: "read-failed", detail: `${e.stage}: ${e.error}` },
      evidence,
    });
  }
  for (const name of input.deferred?.skippedCycles ?? []) {
    put({
      ...base,
      address: `cycle/${name}`,
      status: "not-observed",
      unobserved: { reason: "not-reached", detail: `the ${name} cycle was deferred by the request budget` },
      evidence,
    });
  }
  return [...byAddress.values()];
}

/** The stream for one read: start, the records, settle. */
export function driftLines(member: string, observedAt: string, records: readonly DriftRecord[]): DriftLine[] {
  const start = driftStart({ member, engine: DRIFT_ENGINE, read: DRIFT_READ, at: observedAt, expected: [], evidence: driftEvidence() });
  const settled = driftSettle(start, records, observedAt);
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

const refuse = (code: "read-unsupported" | "resource-unsupported" | "no-drift-read", message: string): DriftReaderOutput => ({ refused: { code, message } });

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
 * Read a forge-governance member's drift. Refuses a read, stack or single
 * resource it does not have, and a missing token, without throwing. A
 * missing or invalid policy throws, which chant reports as a failed read.
 */
export async function readGovernanceDrift(input: DriftReaderInput, deps: ReadGovernanceDriftDeps = {}): Promise<DriftReaderOutput> {
  if (input.read !== undefined && input.read !== DRIFT_READ) {
    return refuse("read-unsupported", `gitlab-warden reads the ${DRIFT_READ} read only (its reconcile dry run), not ${input.read}`);
  }
  if (input.stack !== undefined) return refuse("read-unsupported", "gitlab-warden has no stacks; a governance member is read whole");
  if (input.resource !== undefined) {
    return refuse("resource-unsupported", `gitlab-warden plans whole groups and projects and cannot read ${input.resource} on its own; read the member without --resource`);
  }

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
  if (!path) throw new Error(`no governance policy in ${dir}: neither ${join(dir, file)} nor governance.yaml or governance.ts exists`);
  const { config: policy } = await loadGovernancePolicy(path, "fold");

  const client = (deps.createClient ?? createClient)({ baseUrl, token });
  const result = await runReconcile({
    config: policy,
    client,
    cycles: deps.cycles ?? Object.values(CYCLE_REGISTRY),
    mode: "dry-run",
    ...(deps.requestBudget !== undefined ? { requestBudget: deps.requestBudget } : {}),
  });
  const records = driftRecords({
    member: input.member,
    observedAt: input.observedAt,
    changeSets: result.changeSets,
    errored: result.errored,
    deferred: result.deferred,
    policy,
  });
  return { lines: driftLines(input.member, input.observedAt, records) };
}
