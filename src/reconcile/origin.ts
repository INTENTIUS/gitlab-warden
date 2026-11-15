/**
 * Where a drifted field was written.
 *
 * When a `.ts` policy is folded, `@intentius/tsad-reference` reports, for every
 * leaf of the folded value, which writer produced it (F-Obs-Provenance, spec
 * 2.2): the policy itself (`direct`), a parameter of a project function such
 * as a preset (`composite-parameter`), a literal in that function's body
 * (`composite-literal`), or nothing it can name (`unknown`). This module maps
 * a plan's field change back to its path in the policy, looks that path up,
 * and writes the answer under the field line of the plan, so a drifted field
 * points at the argument or line to edit.
 *
 * A YAML or JSON policy, or a `.ts` policy loaded in `run` mode, has no
 * provenance; the plan is then printed exactly as before.
 */

import type { GovernanceConfig, NodeConfig } from "../config/types.js";
import type { ChangeSet } from "./diff.js";

/** A position in the policy source, 1-based. `file` is relative to the working directory. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/**
 * What produced one field of a folded policy. The same shape as the
 * reference implementation's `FoldFieldOrigin`, restated here so warden's
 * public types do not depend on the evaluator's.
 */
export type FieldOrigin =
  | { kind: "direct" }
  | {
      kind: "composite-parameter";
      composite: string;
      instance?: string;
      parameters: string[];
      call?: SourceLocation;
      arguments?: Record<string, SourceLocation>;
    }
  | {
      kind: "composite-literal";
      composite: string;
      instance?: string;
      call?: SourceLocation;
      literal?: SourceLocation;
    }
  | { kind: "unknown"; reason: string };

/** Every leaf of the policy, by accessor path from the policy root (`nodes["acme/api"].projectSettings.mergeMethod`), to its origin. */
export interface PolicyProvenance {
  paths: Record<string, FieldOrigin>;
}

/** One drifted field and where it was written. `origins` is empty when the fold reported nothing for its path. */
export interface DriftOrigin {
  resourceType: string;
  key: string;
  field: string;
  /** The field's path in the policy, as the provenance writes it. */
  path: string;
  origins: FieldOrigin[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A path segment the way the reference writes it: `.key`, `["key"]`, or `[n]`. */
export function seg(key: string | number): string {
  if (typeof key === "number") return `[${key}]`;
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function join(...keys: Array<string | number>): string {
  return keys.map(seg).join("").replace(/^\./, "");
}

/** The declared node a change set's scope id names: by its key, or by a node whose `previously:` is the scope's path (a pending rename runs under the old path). */
function nodeOf(config: GovernanceConfig, scopeId: string): string | undefined {
  const i = scopeId.indexOf(":");
  const path = i === -1 ? scopeId : scopeId.slice(i + 1);
  if (config.nodes[path]) return path;
  return Object.keys(config.nodes).find((k) => config.nodes[k]?.previously === path);
}

/** Single-object slices: the resource type's slice name on the node. */
const OBJECT_SLICES: Record<string, keyof NodeConfig> = {
  "group-settings": "groupSettings",
  "project-settings": "projectSettings",
  "push-rules": "pushRules",
  "approval-settings": "approvalSettings",
  "job-token-scope": "jobTokenScope",
  "security-policy": "securityPolicy",
  "instance-settings": "instanceSettings",
};

/** List slices: the slice name and the key the diff joins a list member on. */
const LIST_SLICES: Record<string, { slice: keyof NodeConfig; key: (item: Record<string, unknown>) => string }> = {
  member: { slice: "members", key: (m) => String(m.user) },
  "protected-branch": { slice: "protectedBranches", key: (b) => String(b.name) },
  "protected-tag": { slice: "protectedTags", key: (t) => String(t.name) },
  "protected-environment": { slice: "protectedEnvironments", key: (e) => String(e.name) },
  "deploy-key": { slice: "deployKeys", key: (k) => String(k.title) },
  "deploy-token": { slice: "deployTokens", key: (t) => String(t.name) },
  "access-token": { slice: "accessTokens", key: (t) => String(t.name) },
  "member-role": { slice: "memberRoles", key: (r) => String(r.name) },
  "compliance-framework": { slice: "complianceFrameworks", key: (f) => String(f.name) },
  "approval-rule": { slice: "approvalRules", key: (r) => String(r.name) },
  variable: { slice: "variables", key: (v) => `${String(v.key)}@${(v.environmentScope as string | undefined) ?? "*"}` },
  "instance-variable": { slice: "instanceVariables", key: (v) => `${String(v.key)}@${(v.environmentScope as string | undefined) ?? "*"}` },
  "pipeline-schedule": { slice: "pipelineSchedules", key: (s) => String(s.description) },
  webhook: { slice: "webhooks", key: (w) => String(w.url) },
  "system-hook": { slice: "systemHooks", key: (w) => String(w.url) },
  integration: { slice: "integrations", key: (i) => String(i.name) },
};

/**
 * The policy path of a field in a plan entry, or undefined when the entry has
 * no field-level counterpart in the policy. `scopeId` is the change set's
 * scope (`group:acme/platform`); field names in a change set are already the
 * policy's, and list members are found by the key the diff joins on. A
 * rename's synthetic `key` field points at the `previously:` that asked for it.
 */
export function configPath(
  config: GovernanceConfig,
  scopeId: string,
  resourceType: string,
  key: string,
  field: string,
): string | undefined {
  const node = nodeOf(config, scopeId);
  if (node === undefined) return undefined;
  const nc = config.nodes[node]!;
  if (resourceType === "node") return field === "key" ? join("nodes", node, "previously") : undefined;
  const object = OBJECT_SLICES[resourceType];
  if (object) return join("nodes", node, object, field);
  const list = LIST_SLICES[resourceType];
  if (!list) return undefined;
  const items = nc[list.slice] as Array<Record<string, unknown>> | undefined;
  const i = items?.findIndex((item) => list.key(item) === key) ?? -1;
  if (i === -1) return undefined;
  return join("nodes", node, list.slice, i, field === "key" ? "previously" : field);
}

/**
 * The origins of the value at `path`. The reference reports leaves only, so a
 * scalar field is an exact hit; a list field such as `topics` is the distinct
 * origins of its elements; a path under a reported leaf takes that leaf's.
 */
export function originAt(prov: PolicyProvenance, path: string): FieldOrigin[] {
  const exact = prov.paths[path];
  if (exact) return [exact];

  const seen = new Set<string>();
  const below: FieldOrigin[] = [];
  for (const [p, o] of Object.entries(prov.paths)) {
    if (p.startsWith(`${path}.`) || p.startsWith(`${path}[`)) {
      const id = JSON.stringify(o);
      if (!seen.has(id)) {
        seen.add(id);
        below.push(o);
      }
    }
  }
  if (below.length > 0) return below;

  // Nearest reported ancestor: strip one trailing segment at a time.
  let at = path;
  for (;;) {
    const m = /(\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])$/.exec(at);
    if (!m || m.index === 0) return [];
    at = at.slice(0, m.index);
    const o = prov.paths[at];
    if (o) return [o];
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const loc = (at: SourceLocation): string => `${at.file}:${at.line}:${at.column}`;

/** One origin as the plan prints it after `<- `. */
export function formatOrigin(o: FieldOrigin): string {
  switch (o.kind) {
    case "direct":
      return "direct";
    case "composite-parameter": {
      const parts = o.parameters.map((p) => {
        const at = o.arguments?.[p];
        if (at) return `argument ${p} at ${loc(at)}`;
        return `parameter ${p} (default applied)${o.call ? `, called at ${loc(o.call)}` : ""}`;
      });
      return `${o.composite}(...) ${parts.join(", ")}`;
    }
    case "composite-literal": {
      const lit = o.literal ? ` at ${loc(o.literal)}` : "";
      const call = o.call ? `, called at ${loc(o.call)}` : "";
      return `${o.composite}(...) sets it in its body${lit}${call}`;
    }
    case "unknown":
      return `unknown (${o.reason})`;
  }
}

/** The text after `<- ` for a field: every distinct origin, or `unknown (not reported)` when the fold named none. */
export function formatOrigins(origins: FieldOrigin[]): string {
  if (origins.length === 0) return "unknown (not reported)";
  return origins.map(formatOrigin).join("; ");
}

/** The origin of every drifted field in a change set, in entry order. Only `update` entries carry field changes. */
export function driftOrigins(
  changeSet: ChangeSet,
  config: GovernanceConfig,
  prov: PolicyProvenance,
): DriftOrigin[] {
  const out: DriftOrigin[] = [];
  for (const e of changeSet.entries) {
    if (e.kind !== "update") continue;
    for (const f of e.fields ?? []) {
      const path = configPath(config, changeSet.org, e.resourceType, e.key, f.field);
      if (path === undefined) continue;
      out.push({ resourceType: e.resourceType, key: e.key, field: f.field, path, origins: originAt(prov, path) });
    }
  }
  return out;
}

/**
 * Write each drifted field's origin under its line in a rendered plan:
 *
 *     [project-settings] project-settings
 *       mergeMethod: merge → ff
 *         <- reviewPreset(...) argument linear at examples/governance.ts:14:44
 *
 * The plan is chant's `renderChangeSet` output: an entry line `  [type] key`
 * followed by its field lines `    field: before → after`.
 */
export function annotatePlan(plan: string, drift: DriftOrigin[]): string {
  if (drift.length === 0) return plan;
  const byField = new Map(drift.map((d) => [`${d.resourceType}\0${d.key}\0${d.field}`, d]));
  let entry: string | undefined;
  const out: string[] = [];
  for (const line of plan.split("\n")) {
    out.push(line);
    const head = /^ {2}\[([^\]]+)\] (.+)$/.exec(line);
    if (head) {
      entry = `${head[1]}\0${head[2]}`;
      continue;
    }
    const field = /^ {4}([^\s:]+): /.exec(line);
    if (field && entry !== undefined) {
      const d = byField.get(`${entry}\0${field[1]}`);
      if (d) out.push(`      <- ${formatOrigins(d.origins)}`);
    }
  }
  return out.join("\n");
}
