/**
 * Compliance-frameworks cycle — group-level framework definitions (GraphQL).
 *
 *   fetchLive — query group.complianceFrameworks
 *   apply     — create/update/destroyComplianceFramework mutations
 *
 * Group nodes only; Premium/Ultimate-gated. Project *assignment* of frameworks
 * is a separate concern (a follow-up under #17).
 *
 * ⚠️ The GraphQL operations follow the documented GitLab schema but are
 * UNVALIDATED against a live Ultimate instance (the hermetic e2e runs GitLab CE,
 * which lacks compliance frameworks). Treat as best-effort until exercised
 * against a real Ultimate group.
 */

import type { GitLabClient } from "../auth/client.js";
import type { NodeConfig, ComplianceFrameworkConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveComplianceFramework } from "../reconcile/live.js";
import { charge, isForbidden } from "./_shared.js";

export type ComplianceFrameworksScope = Record<string, never>;

const LIST_QUERY = `query GroupComplianceFrameworks($fullPath: ID!) {
  group(fullPath: $fullPath) {
    complianceFrameworks { nodes { id name description color pipelineConfigurationFullPath } }
  }
}`;

const CREATE = `mutation CreateComplianceFramework($input: CreateComplianceFrameworkInput!) {
  createComplianceFramework(input: $input) { framework { id } errors }
}`;
const UPDATE = `mutation UpdateComplianceFramework($input: UpdateComplianceFrameworkInput!) {
  updateComplianceFramework(input: $input) { complianceFramework { id } errors }
}`;
const DESTROY = `mutation DestroyComplianceFramework($input: DestroyComplianceFrameworkInput!) {
  destroyComplianceFramework(input: $input) { errors }
}`;

interface ListResult {
  group?: { complianceFrameworks?: { nodes?: Array<{ id?: string; name?: string; description?: string; color?: string; pipelineConfigurationFullPath?: string }> } } | null;
}

function frameworkParams(d: ComplianceFrameworkConfig): Record<string, unknown> {
  const params: Record<string, unknown> = { name: d.name };
  if (d.description !== undefined) params.description = d.description;
  if (d.color !== undefined) params.color = d.color;
  if (d.pipelineConfigurationFullPath !== undefined) params.pipelineConfigurationFullPath = d.pipelineConfigurationFullPath;
  return params;
}

export const complianceFrameworksCycle: Cycle<ComplianceFrameworksScope> = {
  name: "compliance-frameworks",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: ComplianceFrameworksScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "group") return {};
    charge(budget);
    try {
      const data = await client.graphql<ListResult>(LIST_QUERY, { fullPath: path });
      const nodes = data.group?.complianceFrameworks?.nodes ?? [];
      const complianceFrameworks: LiveComplianceFramework[] = nodes
        .filter((n) => n.name)
        .map((n) => {
          const f: LiveComplianceFramework = { name: n.name! };
          if (n.id) f.id = n.id;
          if (n.description != null) f.description = n.description;
          if (n.color != null) f.color = n.color;
          if (n.pipelineConfigurationFullPath != null) f.pipelineConfigurationFullPath = n.pipelineConfigurationFullPath;
          return f;
        });
      return { complianceFrameworks };
    } catch (err) {
      if (isForbidden(err)) return {};
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "group" || !config.complianceFrameworks) return { kind: config.kind };
    return { kind: "group", complianceFrameworks: config.complianceFrameworks };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: ComplianceFrameworksScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "compliance-framework") return;
    const { path } = parseScope(scopeId);

    if (entry.kind === "create") {
      charge(budget);
      await client.graphql(CREATE, { input: { namespacePath: path, params: frameworkParams(entry.after as ComplianceFrameworkConfig) } });
      return;
    }
    const id = (entry.before as LiveComplianceFramework | undefined)?.id;
    if (!id) throw new Error(`compliance framework '${entry.key}' has no live id`);
    if (entry.kind === "update") {
      charge(budget);
      await client.graphql(UPDATE, { input: { id, params: frameworkParams(entry.after as ComplianceFrameworkConfig) } });
      return;
    }
    charge(budget);
    await client.graphql(DESTROY, { input: { id } });
  },
};
