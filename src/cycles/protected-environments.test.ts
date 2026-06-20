import { describe, it, expect } from "vitest";
import { protectedEnvironmentsCycle, buildEnvBody } from "./protected-environments.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("buildEnvBody", () => {
  it("nests deploy access levels", () => {
    expect(buildEnvBody({ name: "production", deployAccessLevels: [40], requiredApprovalCount: 1 })).toEqual({
      name: "production",
      deploy_access_levels: [{ access_level: 40 }],
      required_approval_count: 1,
    });
  });
});

describe("protectedEnvironmentsCycle.fetchLive", () => {
  it("maps deploy_access_levels + required_approval_count", async () => {
    const client = makeClient({}, {
      "/projects/acme%2Fapi/protected_environments": [{ name: "production", deploy_access_levels: [{ access_level: 40 }], required_approval_count: 1 }],
    });
    const live = await protectedEnvironmentsCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.protectedEnvironments).toEqual([{ name: "production", deployAccessLevels: [40], requiredApprovalCount: 1 }]);
  });
  it("tolerates 403 (Premium)", async () => {
    const client = makeClient();
    client.paginate = async () => { throw new Error("403 Forbidden"); };
    expect(await protectedEnvironmentsCycle.fetchLive(client, PROJECT, scope, makeBudget())).toEqual({});
  });
  it("reads group environments from the group endpoint", async () => {
    const client = makeClient({}, { "/groups/acme/protected_environments": [] });
    await protectedEnvironmentsCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(client.calls[0]!.path).toBe("/groups/acme/protected_environments");
  });
});

describe("protectedEnvironmentsCycle.apply", () => {
  it("create POSTs; update re-protects", async () => {
    const c1 = makeClient();
    await protectedEnvironmentsCycle.apply(c1, { kind: "create", resourceType: "protected-environment", key: "production", after: { name: "production", deployAccessLevels: [40] } }, PROJECT, scope, makeBudget());
    expect(c1.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/protected_environments" });
    const c2 = makeClient();
    await protectedEnvironmentsCycle.apply(c2, { kind: "update", resourceType: "protected-environment", key: "production", before: { name: "production" }, after: { name: "production", requiredApprovalCount: 2 }, fields: [] }, PROJECT, scope, makeBudget());
    expect(c2.calls.map((c) => c.method)).toEqual(["DELETE", "POST"]);
  });
});

describe("protectedEnvironmentsCycle via runReconcile", () => {
  it("creates a missing protected environment", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", protectedEnvironments: [{ name: "production", deployAccessLevels: [40] }] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/protected_environments": [] });
    const result = await runReconcile({ config, client, cycles: [protectedEnvironmentsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
  });
});
