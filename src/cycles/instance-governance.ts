/**
 * Instance-governance cycle — self-managed instance-level config.
 *
 * Acts only on `instance` nodes (scope id `instance:…`). Every endpoint requires
 * instance admin and is absent on GitLab.com, so all reads tolerate 403/404 and
 * the cycle simply manages nothing there.
 *
 *   instance-settings — GET/PUT /application/settings  (generic key passthrough)
 *   system-hook       — GET/POST/DELETE /hooks         (no PUT → re-create on drift)
 *   instance-variable — GET/POST/PUT/DELETE /admin/ci/variables
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, VariableConfig, WebhookConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveWebhook, LiveVariable } from "../reconcile/live.js";
import { charge, isForbidden, isNotFound } from "./_shared.js";

export type InstanceGovernanceScope = Record<string, never>;

interface GlHook {
  id?: number;
  url?: string;
  push_events?: boolean;
  tag_push_events?: boolean;
  merge_requests_events?: boolean;
  enable_ssl_verification?: boolean;
}
interface GlVar {
  key?: string;
  value?: string;
  protected?: boolean;
  masked?: boolean;
  variable_type?: string;
}

function mapHook(raw: GlHook): LiveWebhook | null {
  if (!raw.url) return null;
  const h: LiveWebhook = { url: raw.url };
  if (typeof raw.id === "number") h.id = raw.id;
  if (typeof raw.push_events === "boolean") h.pushEvents = raw.push_events;
  if (typeof raw.tag_push_events === "boolean") h.tagPushEvents = raw.tag_push_events;
  if (typeof raw.merge_requests_events === "boolean") h.mergeRequestsEvents = raw.merge_requests_events;
  if (typeof raw.enable_ssl_verification === "boolean") h.enableSslVerification = raw.enable_ssl_verification;
  return h;
}
function mapVar(raw: GlVar): LiveVariable {
  const v: LiveVariable = { key: raw.key ?? "" };
  if (raw.value !== undefined) v.value = raw.value;
  if (typeof raw.protected === "boolean") v.protected = raw.protected;
  if (typeof raw.masked === "boolean") v.masked = raw.masked;
  if (raw.variable_type !== undefined) v.variableType = raw.variable_type;
  return v;
}

function hookBody(w: WebhookConfig): Record<string, unknown> {
  const body: Record<string, unknown> = { url: w.url };
  if (w.pushEvents !== undefined) body.push_events = w.pushEvents;
  if (w.tagPushEvents !== undefined) body.tag_push_events = w.tagPushEvents;
  if (w.mergeRequestsEvents !== undefined) body.merge_requests_events = w.mergeRequestsEvents;
  if (w.enableSslVerification !== undefined) body.enable_ssl_verification = w.enableSslVerification;
  if (w.token !== undefined) body.token = w.token;
  return body;
}

async function tolerantPaginate<T>(client: GitLabClient, path: string): Promise<T[] | undefined> {
  try {
    return await client.paginate<T>(path);
  } catch (err) {
    if (isForbidden(err) || isNotFound(err)) return undefined;
    throw err;
  }
}

export const instanceGovernanceCycle: Cycle<InstanceGovernanceScope> = {
  name: "instance-governance",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: InstanceGovernanceScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    if (parseScope(scopeId).kind !== "instance") return {};
    const out: LiveNodeState = {};
    charge(budget);
    try {
      out.instanceSettings = await client.request<Record<string, unknown>>("GET", "/application/settings");
    } catch (err) {
      if (!isForbidden(err) && !isNotFound(err)) throw err;
    }
    charge(budget);
    const hooks = await tolerantPaginate<GlHook>(client, "/hooks");
    if (hooks) out.systemHooks = hooks.map(mapHook).filter((h): h is LiveWebhook => h !== null);
    charge(budget);
    const vars = await tolerantPaginate<GlVar>(client, "/admin/ci/variables");
    if (vars) out.instanceVariables = vars.filter((v) => v.key).map(mapVar);
    return out;
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "instance") return { kind: config.kind };
    const out: NodeConfig = { kind: "instance" };
    if (config.instanceSettings !== undefined) out.instanceSettings = config.instanceSettings;
    if (config.systemHooks !== undefined) out.systemHooks = config.systemHooks;
    if (config.instanceVariables !== undefined) out.instanceVariables = config.instanceVariables;
    return out;
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    _scopeId: string,
    _scope: InstanceGovernanceScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType === "instance-settings") {
      charge(budget);
      await client.request("PUT", "/application/settings", entry.after as Record<string, unknown>);
      return;
    }
    if (entry.resourceType === "system-hook") {
      if (entry.kind === "delete" || entry.kind === "update") {
        const id = (entry.before as LiveWebhook | undefined)?.id;
        if (typeof id === "number") {
          charge(budget);
          await client.request("DELETE", `/hooks/${id}`);
        }
        if (entry.kind === "delete") return;
      }
      charge(budget);
      await client.request("POST", "/hooks", hookBody(entry.after as WebhookConfig));
      return;
    }
    if (entry.resourceType === "instance-variable") {
      const key = entry.key.slice(0, entry.key.indexOf("@"));
      const base = "/admin/ci/variables";
      if (entry.kind === "delete") {
        charge(budget);
        await client.request("DELETE", `${base}/${encodeId(key)}`);
        return;
      }
      const d = entry.after as VariableConfig;
      const body: Record<string, unknown> = {};
      if (d.value !== undefined) body.value = d.value;
      if (d.protected !== undefined) body.protected = d.protected;
      if (d.masked !== undefined) body.masked = d.masked;
      if (d.variableType !== undefined) body.variable_type = d.variableType;
      charge(budget);
      if (entry.kind === "create") {
        await client.request("POST", base, { key, value: d.value ?? "", ...body });
      } else {
        await client.request("PUT", `${base}/${encodeId(key)}`, body);
      }
    }
  },
};
