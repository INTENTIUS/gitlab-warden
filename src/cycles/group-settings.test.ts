import { describe, it, expect } from "vitest";
import { groupSettingsCycle, buildGroupBody } from "./group-settings.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const GROUP = "group:acme/platform";

describe("buildGroupBody", () => {
  it("maps declared fields to GitLab snake_case", () => {
    expect(buildGroupBody({ description: "x", visibility: "private", requestAccessEnabled: false })).toEqual({
      description: "x",
      visibility: "private",
      request_access_enabled: false,
    });
  });
});

describe("groupSettingsCycle.fetchLive", () => {
  it("GETs /groups/:encodedPath and maps the response", async () => {
    const client = makeClient({
      "GET /groups/acme%2Fplatform": { name: "Platform", visibility: "internal", request_access_enabled: true },
    });
    const live = await groupSettingsCycle.fetchLive(client, GROUP, scope, makeBudget());
    expect(live.groupSettings).toEqual({ name: "Platform", visibility: "internal", requestAccessEnabled: true });
    expect(client.calls[0]!.path).toBe("/groups/acme%2Fplatform");
  });
  it("is a no-op on project nodes", async () => {
    const client = makeClient();
    const live = await groupSettingsCycle.fetchLive(client, "project:acme/api", scope, makeBudget());
    expect(live).toEqual({});
    expect(client.calls).toHaveLength(0);
  });
  it("404 → empty", async () => {
    const client = makeClient({
      "GET /groups/ghost": () => {
        throw new Error("GET returned 404");
      },
    });
    const live = await groupSettingsCycle.fetchLive(client, "group:ghost", scope, makeBudget());
    expect(live.groupSettings).toBeUndefined();
  });
});

describe("groupSettingsCycle.buildDesired", () => {
  it("keeps only groupSettings for group nodes", () => {
    const cfg = { kind: "group" as const, groupSettings: { description: "d" }, members: [{ user: "a", accessLevel: 30 }] };
    expect(groupSettingsCycle.buildDesired(cfg, GROUP, scope)).toEqual({ kind: "group", groupSettings: { description: "d" } });
  });
  it("drops the slice on project nodes", () => {
    expect(groupSettingsCycle.buildDesired({ kind: "project" }, "project:x", scope)).toEqual({ kind: "project" });
  });
});

describe("groupSettingsCycle.apply", () => {
  it("PUTs declared fields to /groups/:id", async () => {
    const client = makeClient();
    await groupSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "group-settings", key: "group-settings", after: { description: "new" } },
      GROUP,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/groups/acme%2Fplatform", body: { description: "new" } });
  });
  it("ignores foreign resource types", async () => {
    const client = makeClient();
    await groupSettingsCycle.apply(client, { kind: "create", resourceType: "member", key: "x", after: {} }, GROUP, scope, makeBudget());
    expect(client.calls).toHaveLength(0);
  });
});

describe("groupSettingsCycle via runReconcile", () => {
  const config: GovernanceConfig = { nodes: { "acme/platform": { kind: "group", groupSettings: { description: "want" } } } };
  it("dry-run reports the update without mutating", async () => {
    const client = makeClient({ "GET /groups/acme%2Fplatform": { description: "have" } });
    const result = await runReconcile({ config, client, cycles: [groupSettingsCycle], mode: "dry-run" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("apply PUTs after the GET", async () => {
    const client = makeClient({ "GET /groups/acme%2Fplatform": { description: "have" } });
    const result = await runReconcile({ config, client, cycles: [groupSettingsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(client.calls.find((c) => c.method === "PUT")!.body).toEqual({ description: "want" });
  });
});
