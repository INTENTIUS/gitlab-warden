import { describe, it, expect } from "vitest";
import { protectedTagsCycle, buildTagBody } from "./protected-tags.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("buildTagBody", () => {
  it("includes name + create access level", () => {
    expect(buildTagBody({ name: "v*", createAccessLevel: 40 })).toEqual({ name: "v*", create_access_level: 40 });
  });
});

describe("protectedTagsCycle.fetchLive", () => {
  it("maps create_access_levels to a single level", async () => {
    const client = makeClient({}, { "/projects/acme%2Fapi/protected_tags": [{ name: "v*", create_access_levels: [{ access_level: 40 }] }] });
    const live = await protectedTagsCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.protectedTags).toEqual([{ name: "v*", createAccessLevel: 40 }]);
  });
  it("no-op on group nodes", async () => {
    expect(await protectedTagsCycle.fetchLive(makeClient(), "group:acme", scope, makeBudget())).toEqual({});
  });
});

describe("protectedTagsCycle.apply", () => {
  it("create POSTs", async () => {
    const client = makeClient();
    await protectedTagsCycle.apply(client, { kind: "create", resourceType: "protected-tag", key: "v*", after: { name: "v*", createAccessLevel: 40 } }, PROJECT, scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/protected_tags", body: { name: "v*", create_access_level: 40 } });
  });
  it("update re-protects (DELETE then POST)", async () => {
    const client = makeClient();
    await protectedTagsCycle.apply(client, { kind: "update", resourceType: "protected-tag", key: "v*", before: { name: "v*" }, after: { name: "v*", createAccessLevel: 30 }, fields: [] }, PROJECT, scope, makeBudget());
    expect(client.calls.map((c) => c.method)).toEqual(["DELETE", "POST"]);
  });
});

describe("protectedTagsCycle via runReconcile", () => {
  it("creates a missing protected tag", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", protectedTags: [{ name: "v*", createAccessLevel: 40 }] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/protected_tags": [] });
    const result = await runReconcile({ config, client, cycles: [protectedTagsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
  });
});
