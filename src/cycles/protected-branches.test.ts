import { describe, it, expect } from "vitest";
import { protectedBranchesCycle, buildBranchBody } from "./protected-branches.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("buildBranchBody", () => {
  it("includes name + declared access levels", () => {
    expect(buildBranchBody({ name: "main", pushAccessLevel: 40, allowForcePush: false })).toEqual({
      name: "main",
      push_access_level: 40,
      allow_force_push: false,
    });
  });
});

describe("protectedBranchesCycle.fetchLive", () => {
  it("maps access-level arrays to single CE levels", async () => {
    const client = makeClient({}, {
      "/projects/acme%2Fapi/protected_branches": [
        { name: "main", push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 30 }], allow_force_push: false },
      ],
    });
    const live = await protectedBranchesCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.protectedBranches).toEqual([{ name: "main", pushAccessLevel: 40, mergeAccessLevel: 30, allowForcePush: false }]);
  });
  it("no-op on group nodes", async () => {
    const client = makeClient();
    expect(await protectedBranchesCycle.fetchLive(client, "group:acme", scope, makeBudget())).toEqual({});
  });
});

describe("protectedBranchesCycle.apply", () => {
  it("create POSTs", async () => {
    const client = makeClient();
    await protectedBranchesCycle.apply(
      client,
      { kind: "create", resourceType: "protected-branch", key: "main", after: { name: "main", pushAccessLevel: 40 } },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/protected_branches", body: { name: "main", push_access_level: 40 } });
  });
  it("update re-protects (DELETE then POST), url-encoding globs", async () => {
    const client = makeClient();
    await protectedBranchesCycle.apply(
      client,
      { kind: "update", resourceType: "protected-branch", key: "release/*", before: { name: "release/*" }, after: { name: "release/*", pushAccessLevel: 30 }, fields: [] },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /projects/acme%2Fapi/protected_branches/release%2F*",
      "POST /projects/acme%2Fapi/protected_branches",
    ]);
  });
  it("delete DELETEs by name", async () => {
    const client = makeClient();
    await protectedBranchesCycle.apply(
      client,
      { kind: "delete", resourceType: "protected-branch", key: "main", before: { name: "main" } },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/projects/acme%2Fapi/protected_branches/main" });
  });
});

describe("protectedBranchesCycle via runReconcile", () => {
  it("creates a missing rule end-to-end", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", protectedBranches: [{ name: "main", pushAccessLevel: 40 }] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/protected_branches": [] });
    const result = await runReconcile({ config, client, cycles: [protectedBranchesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.some((c) => c.method === "POST")).toBe(true);
  });
});
