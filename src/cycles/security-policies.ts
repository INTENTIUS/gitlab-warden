/**
 * Security-policies cycle — links/unlinks the security policy project for a
 * group or project node (GraphQL).
 *
 *   fetchLive — query node.securityPolicyProject.fullPath
 *   apply     — securityPolicyProjectAssign / …Unassign
 *
 * The policy *content* (`.gitlab/security-policies/policy.yml`) lives in the
 * linked project and is reconciled separately (deferred follow-up under #18) —
 * it's already native as-code, so the high-value piece here is the linkage.
 *
 * ⚠️ Ultimate-gated and the GraphQL operations are UNVALIDATED against a live
 * Ultimate instance (the hermetic e2e runs GitLab CE, which lacks security
 * policies). Best-effort per the documented schema; unit-tested via the mock.
 */

import type { GitLabClient } from "../auth/client.js";
import type { NodeConfig, SecurityPolicyConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState } from "../reconcile/live.js";
import { charge, isForbidden } from "./_shared.js";

export type SecurityPoliciesScope = Record<string, never>;

const groupQuery = `query GroupSecurityPolicyProject($fullPath: ID!) {
  group(fullPath: $fullPath) { securityPolicyProject { fullPath } }
}`;
const projectQuery = `query ProjectSecurityPolicyProject($fullPath: ID!) {
  project(fullPath: $fullPath) { securityPolicyProject { fullPath } }
}`;
const ASSIGN = `mutation SecurityPolicyProjectAssign($input: SecurityPolicyProjectAssignInput!) {
  securityPolicyProjectAssign(input: $input) { errors }
}`;
const UNASSIGN = `mutation SecurityPolicyProjectUnassign($input: SecurityPolicyProjectUnassignInput!) {
  securityPolicyProjectUnassign(input: $input) { errors }
}`;
const PROJECT_ID = `query ProjectGid($fullPath: ID!) { project(fullPath: $fullPath) { id } }`;

interface NodeResult {
  group?: { securityPolicyProject?: { fullPath?: string } | null } | null;
  project?: { id?: string; securityPolicyProject?: { fullPath?: string } | null } | null;
}

export const securityPoliciesCycle: Cycle<SecurityPoliciesScope> = {
  name: "security-policies",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: SecurityPoliciesScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "group" && kind !== "project") return {};
    charge(budget);
    try {
      const data = await client.graphql<NodeResult>(kind === "group" ? groupQuery : projectQuery, { fullPath: path });
      const node = kind === "group" ? data.group : data.project;
      const linked = node?.securityPolicyProject?.fullPath;
      return { securityPolicy: linked ? { policyProject: linked } : {} };
    } catch (err) {
      if (isForbidden(err)) return {};
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind === "instance" || !config.securityPolicy) return { kind: config.kind };
    return { kind: config.kind, securityPolicy: config.securityPolicy };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: SecurityPoliciesScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "security-policy") return;
    const { path } = parseScope(scopeId);
    const desired = entry.after as SecurityPolicyConfig;

    if (!desired.policyProject) {
      charge(budget);
      await client.graphql(UNASSIGN, { input: { fullPathOrId: path } });
      return;
    }
    // Resolve the policy project's full path → gid, then assign.
    charge(budget);
    const pp = await client.graphql<{ project?: { id?: string } }>(PROJECT_ID, { fullPath: desired.policyProject });
    const gid = pp.project?.id;
    if (!gid) throw new Error(`policy project '${desired.policyProject}' not found`);
    charge(budget);
    await client.graphql(ASSIGN, { input: { fullPathOrId: path, securityPolicyProjectId: gid } });
  },
};
