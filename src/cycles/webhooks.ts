/**
 * Webhooks cycle — group and project webhooks (keyed by URL).
 *
 * GitLab addresses a hook by numeric id, but config/diff key it by URL, so
 * fetchLive carries the live hook `id` (never diffed) for the apply path.
 *
 *   fetchLive — GET /{groups|projects}/:id/hooks (paginated)
 *   apply
 *     create → POST   …/hooks
 *     update → PUT    …/hooks/:id
 *     delete → DELETE …/hooks/:id
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, WebhookConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveWebhook } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type WebhooksScope = Record<string, never>;

interface GlHook {
  id?: number;
  url?: string;
  push_events?: boolean;
  merge_requests_events?: boolean;
  tag_push_events?: boolean;
  issues_events?: boolean;
  pipeline_events?: boolean;
  enable_ssl_verification?: boolean;
}

function mapHook(raw: GlHook): LiveWebhook | null {
  if (!raw.url) return null;
  const h: LiveWebhook = { url: raw.url };
  if (typeof raw.id === "number") h.id = raw.id;
  if (typeof raw.push_events === "boolean") h.pushEvents = raw.push_events;
  if (typeof raw.merge_requests_events === "boolean") h.mergeRequestsEvents = raw.merge_requests_events;
  if (typeof raw.tag_push_events === "boolean") h.tagPushEvents = raw.tag_push_events;
  if (typeof raw.issues_events === "boolean") h.issuesEvents = raw.issues_events;
  if (typeof raw.pipeline_events === "boolean") h.pipelineEvents = raw.pipeline_events;
  if (typeof raw.enable_ssl_verification === "boolean") h.enableSslVerification = raw.enable_ssl_verification;
  return h;
}

/** Build a hook body (camelCase → GitLab snake_case). `url` + write-only token on create. */
export function buildHookBody(w: WebhookConfig, includeUrl: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (includeUrl) body.url = w.url;
  if (w.pushEvents !== undefined) body.push_events = w.pushEvents;
  if (w.mergeRequestsEvents !== undefined) body.merge_requests_events = w.mergeRequestsEvents;
  if (w.tagPushEvents !== undefined) body.tag_push_events = w.tagPushEvents;
  if (w.issuesEvents !== undefined) body.issues_events = w.issuesEvents;
  if (w.pipelineEvents !== undefined) body.pipeline_events = w.pipelineEvents;
  if (w.enableSslVerification !== undefined) body.enable_ssl_verification = w.enableSslVerification;
  if (w.token !== undefined) body.token = w.token;
  return body;
}

function resourceFor(scopeId: string): { base: string } {
  const { kind, path } = parseScope(scopeId);
  const resource = kind === "group" ? "groups" : "projects";
  return { base: `/${resource}/${encodeId(path)}/hooks` };
}

export const webhooksCycle: Cycle<WebhooksScope> = {
  name: "webhooks",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: WebhooksScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { base } = resourceFor(scopeId);
    charge(budget);
    const raw = await client.paginate<GlHook>(base);
    return { webhooks: raw.map(mapHook).filter((h): h is LiveWebhook => h !== null) };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (!config.webhooks) return { kind: config.kind };
    return { kind: config.kind, webhooks: config.webhooks };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: WebhooksScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "webhook") return;
    const { base } = resourceFor(scopeId);

    if (entry.kind === "create") {
      charge(budget);
      await client.request("POST", base, buildHookBody(entry.after as WebhookConfig, true));
      return;
    }
    const id = (entry.before as LiveWebhook | undefined)?.id;
    if (typeof id !== "number") throw new Error(`webhook '${entry.key}' has no live id`);
    if (entry.kind === "update") {
      charge(budget);
      await client.request("PUT", `${base}/${id}`, buildHookBody(entry.after as WebhookConfig, false));
      return;
    }
    charge(budget);
    await client.request("DELETE", `${base}/${id}`);
  },
};
