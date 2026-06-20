/**
 * CI/CD variables cycle — group and project variables.
 *
 *   fetchLive — GET /{groups|projects}/:id/variables (paginated)
 *   apply     — POST / PUT / DELETE, keyed by (key, environment_scope)
 *
 * Values are reconciled fully (these are not write-only secrets). A value may be
 * sourced from `GITLAB_VAR_<KEY>` in the environment instead of committed to
 * config, for protected/sensitive values.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, VariableConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveVariable } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type CiVariablesScope = Record<string, never>;

interface GlVariable {
  key?: string;
  value?: string;
  environment_scope?: string;
  protected?: boolean;
  masked?: boolean;
  variable_type?: string;
}

function mapVariable(raw: GlVariable): LiveVariable {
  const v: LiveVariable = { key: raw.key ?? "" };
  if (raw.value !== undefined) v.value = raw.value;
  if (raw.environment_scope !== undefined) v.environmentScope = raw.environment_scope;
  if (typeof raw.protected === "boolean") v.protected = raw.protected;
  if (typeof raw.masked === "boolean") v.masked = raw.masked;
  if (raw.variable_type !== undefined) v.variableType = raw.variable_type;
  return v;
}

function resourceFor(scopeId: string): { base: string } {
  const { kind, path } = parseScope(scopeId);
  const resource = kind === "group" ? "groups" : "projects";
  return { base: `/${resource}/${encodeId(path)}/variables` };
}

/** Split a `KEY@scope` change key (variable keys can't contain `@`). */
function splitVarKey(key: string): { name: string; scope: string } {
  const at = key.indexOf("@");
  return { name: key.slice(0, at), scope: key.slice(at + 1) };
}

function flagsBody(d: VariableConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (d.protected !== undefined) body.protected = d.protected;
  if (d.masked !== undefined) body.masked = d.masked;
  if (d.variableType !== undefined) body.variable_type = d.variableType;
  return body;
}

function resolveValue(d: VariableConfig): string {
  return d.value ?? process.env[`GITLAB_VAR_${d.key}`] ?? "";
}

export const ciVariablesCycle: Cycle<CiVariablesScope> = {
  name: "ci-variables",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: CiVariablesScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { base } = resourceFor(scopeId);
    charge(budget);
    const raw = await client.paginate<GlVariable>(base);
    return { variables: raw.filter((v) => v.key).map(mapVariable) };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (!config.variables) return { kind: config.kind };
    return { kind: config.kind, variables: config.variables };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: CiVariablesScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "variable") return;
    const { base } = resourceFor(scopeId);
    const { name, scope } = splitVarKey(entry.key);
    const filter = `?filter[environment_scope]=${encodeURIComponent(scope)}`;

    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", `${base}/${encodeId(name)}${filter}`);
      return;
    }
    const after = entry.after as VariableConfig;
    if (entry.kind === "create") {
      charge(budget);
      await client.request("POST", base, {
        key: name,
        value: resolveValue(after),
        environment_scope: scope,
        ...flagsBody(after),
      });
      return;
    }
    // update
    const body: Record<string, unknown> = { ...flagsBody(after) };
    if (after.value !== undefined) body.value = after.value;
    charge(budget);
    await client.request("PUT", `${base}/${encodeId(name)}${filter}`, body);
  },
};
