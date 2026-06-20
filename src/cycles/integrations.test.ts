import { describe, it, expect } from "vitest";
import { integrationsCycle } from "./integrations.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("integrationsCycle.fetchLive", () => {
  it("keeps only active integrations, keyed by slug", async () => {
    const client = makeClient({}, {
      "/projects/acme%2Fapi/integrations": [{ slug: "slack", active: true }, { slug: "jira", active: false }],
    });
    const live = await integrationsCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.integrations).toEqual([{ name: "slack", active: true }]);
  });
  it("uses /groups for group nodes", async () => {
    const client = makeClient({}, { "/groups/acme/integrations": [] });
    await integrationsCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(client.calls[0]!.path).toBe("/groups/acme/integrations");
  });
});

describe("integrationsCycle.apply", () => {
  it("create/update PUTs properties to /integrations/:slug", async () => {
    const client = makeClient();
    await integrationsCycle.apply(
      client,
      { kind: "create", resourceType: "integration", key: "slack", after: { name: "slack", properties: { webhook: "https://h" } } },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/projects/acme%2Fapi/integrations/slack", body: { webhook: "https://h" } });
  });
  it("delete DELETEs the integration", async () => {
    const client = makeClient();
    await integrationsCycle.apply(client, { kind: "delete", resourceType: "integration", key: "jira", before: { name: "jira" } }, PROJECT, scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/projects/acme%2Fapi/integrations/jira" });
  });
});

describe("integrationsCycle via runReconcile", () => {
  it("enables a missing integration", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", integrations: [{ name: "slack", properties: { webhook: "https://h" } }] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/integrations": [] });
    const result = await runReconcile({ config, client, cycles: [integrationsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.find((c) => c.method === "PUT")!.path).toBe("/projects/acme%2Fapi/integrations/slack");
  });
});
