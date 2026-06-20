import { describe, it, expect } from "vitest";
import { securityPoliciesCycle } from "./security-policies.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("securityPoliciesCycle.fetchLive", () => {
  it("reads the linked policy project path", async () => {
    const client = makeClient({}, {}, { ProjectSecurityPolicyProject: { project: { securityPolicyProject: { fullPath: "acme/policies" } } } });
    const live = await securityPoliciesCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.securityPolicy).toEqual({ policyProject: "acme/policies" });
  });
  it("empty when nothing is linked; tolerates 403; no-op on instance", async () => {
    const c1 = makeClient({}, {}, { ProjectSecurityPolicyProject: { project: { securityPolicyProject: null } } });
    expect(await securityPoliciesCycle.fetchLive(c1, PROJECT, scope, makeBudget())).toEqual({ securityPolicy: {} });
    const c2 = makeClient();
    c2.graphql = async () => { throw new Error("403 Forbidden"); };
    expect(await securityPoliciesCycle.fetchLive(c2, PROJECT, scope, makeBudget())).toEqual({});
    expect(await securityPoliciesCycle.fetchLive(makeClient(), "instance:@instance", scope, makeBudget())).toEqual({});
  });
});

describe("securityPoliciesCycle.apply", () => {
  it("assign resolves the policy project gid then assigns", async () => {
    const client = makeClient({}, {}, { ProjectGid: { project: { id: "gid://99" } } });
    await securityPoliciesCycle.apply(
      client,
      { kind: "create", resourceType: "security-policy", key: "security-policy", after: { policyProject: "acme/policies" } },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => c.path).some((p) => p.includes("ProjectGid"))).toBe(true);
    const assign = client.calls.find((c) => c.path.includes("securityPolicyProjectAssign"))!;
    expect(assign.body).toEqual({ input: { fullPathOrId: "acme/api", securityPolicyProjectId: "gid://99" } });
  });
  it("unassign when policyProject cleared", async () => {
    const client = makeClient();
    await securityPoliciesCycle.apply(
      client,
      { kind: "update", resourceType: "security-policy", key: "security-policy", after: { policyProject: "" }, fields: [] },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]!.path).toContain("securityPolicyProjectUnassign");
  });
});

describe("securityPoliciesCycle via runReconcile", () => {
  it("links a policy project when none is set", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", securityPolicy: { policyProject: "acme/policies" } } } };
    const client = makeClient({}, {}, {
      ProjectSecurityPolicyProject: { project: { securityPolicyProject: null } },
      ProjectGid: { project: { id: "gid://99" } },
    });
    const result = await runReconcile({ config, client, cycles: [securityPoliciesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(client.calls.some((c) => c.path.includes("securityPolicyProjectAssign"))).toBe(true);
  });
});
