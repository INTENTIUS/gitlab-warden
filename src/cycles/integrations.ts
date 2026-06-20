/**
 * Integrations cycle — group/project integrations, modeled generically.
 *
 *   fetchLive — GET /{groups|projects}/:id/integrations (active integrations)
 *   apply
 *     create/update → PUT    …/integrations/:name  (upsert, with properties)
 *     delete        → DELETE …/integrations/:name  (disable)
 *
 * Keyed by the integration slug. `properties` are write-only (GitLab masks
 * them), so property-only drift isn't detected — presence/active is reconciled,
 * and properties are (re)applied on every create/update.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, IntegrationConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveIntegration } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type IntegrationsScope = Record<string, never>;

interface GlIntegration {
  slug?: string;
  name?: string;
  active?: boolean;
}

function resourceFor(scopeId: string): { base: string } {
  const { kind, path } = parseScope(scopeId);
  const resource = kind === "group" ? "groups" : "projects";
  return { base: `/${resource}/${encodeId(path)}/integrations` };
}

export const integrationsCycle: Cycle<IntegrationsScope> = {
  name: "integrations",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: IntegrationsScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { base } = resourceFor(scopeId);
    charge(budget);
    const raw = await client.paginate<GlIntegration>(base);
    const integrations: LiveIntegration[] = raw
      .filter((i) => i.active === true)
      .map((i) => ({ name: i.slug ?? i.name ?? "", active: true }))
      .filter((i) => i.name);
    return { integrations };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (!config.integrations) return { kind: config.kind };
    return { kind: config.kind, integrations: config.integrations };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: IntegrationsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "integration") return;
    const { base } = resourceFor(scopeId);
    const path = `${base}/${encodeId(entry.key)}`;
    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", path);
      return;
    }
    const d = entry.after as IntegrationConfig;
    charge(budget);
    await client.request("PUT", path, { ...(d.properties ?? {}) });
  },
};
