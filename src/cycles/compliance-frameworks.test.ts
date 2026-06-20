import { describe, it, expect } from "vitest";
import { complianceFrameworksCycle } from "./compliance-frameworks.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const GROUP = "group:acme";

describe("complianceFrameworksCycle.fetchLive", () => {
  it("maps group.complianceFrameworks nodes", async () => {
    const client = makeClient({}, {}, {
      GroupComplianceFrameworks: { group: { complianceFrameworks: { nodes: [{ id: "gid://1", name: "SOC2", color: "#1aaa55" }] } } },
    });
    const live = await complianceFrameworksCycle.fetchLive(client, GROUP, scope, makeBudget());
    expect(live.complianceFrameworks).toEqual([{ id: "gid://1", name: "SOC2", color: "#1aaa55" }]);
  });
  it("no-op on project nodes; tolerates 403", async () => {
    expect(await complianceFrameworksCycle.fetchLive(makeClient(), "project:acme/api", scope, makeBudget())).toEqual({});
    const c = makeClient();
    c.graphql = async () => { throw new Error("403 Forbidden"); };
    expect(await complianceFrameworksCycle.fetchLive(c, GROUP, scope, makeBudget())).toEqual({});
  });
});

describe("complianceFrameworksCycle.apply", () => {
  it("create runs createComplianceFramework with namespacePath", async () => {
    const client = makeClient();
    await complianceFrameworksCycle.apply(client, { kind: "create", resourceType: "compliance-framework", key: "SOC2", after: { name: "SOC2", color: "#1aaa55" } }, GROUP, scope, makeBudget());
    const call = client.calls[0]!;
    expect(call.method).toBe("GRAPHQL");
    expect(call.path).toContain("createComplianceFramework");
    expect(call.body).toEqual({ input: { namespacePath: "acme", params: { name: "SOC2", color: "#1aaa55" } } });
  });
  it("update/destroy use the live gid", async () => {
    const c1 = makeClient();
    await complianceFrameworksCycle.apply(c1, { kind: "update", resourceType: "compliance-framework", key: "SOC2", before: { id: "gid://1", name: "SOC2" }, after: { name: "SOC2", color: "#000" }, fields: [] }, GROUP, scope, makeBudget());
    expect((c1.calls[0]!.body as { input: { id: string } }).input.id).toBe("gid://1");
    const c2 = makeClient();
    await complianceFrameworksCycle.apply(c2, { kind: "delete", resourceType: "compliance-framework", key: "SOC2", before: { id: "gid://1", name: "SOC2" } }, GROUP, scope, makeBudget());
    expect(c2.calls[0]!.path).toContain("destroyComplianceFramework");
  });
});

describe("complianceFrameworksCycle via runReconcile", () => {
  it("creates a missing framework", async () => {
    const config: GovernanceConfig = { nodes: { acme: { kind: "group", complianceFrameworks: [{ name: "SOC2" }] } } };
    const client = makeClient({}, {}, { GroupComplianceFrameworks: { group: { complianceFrameworks: { nodes: [] } } } });
    const result = await runReconcile({ config, client, cycles: [complianceFrameworksCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
  });
});
