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

  it("declared `active: false` on a live integration plans a delete (DELETE deactivates), no `owned` needed", async () => {
    // GitLab's PUT upsert (re)activates, so a declared-off integration must
    // take the DELETE path — and as explicit declared intent it bypasses
    // ownership gating (this node declares no `owned`).
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", integrations: [{ name: "slack", active: false }] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/integrations": [{ slug: "slack", active: true }] });
    // The removal cap still counts this delete (1 of 1 live = 100%), so raise
    // the fraction — the point here is the DELETE-not-PUT apply path.
    const result = await runReconcile({ config, client, cycles: [integrationsCycle], mode: "apply", removalDeltaCapFraction: 1 });
    expect(result.cycles[0]!.counts).toEqual({ create: 0, update: 0, delete: 1 });
    const del = client.calls.find((c) => c.method === "DELETE");
    expect(del!.path).toBe("/projects/acme%2Fapi/integrations/slack");
    expect(client.calls.filter((c) => c.method === "PUT")).toHaveLength(0); // never re-activated
  });

  it("declared `active: false` with no live integration is converged (no create, no delete)", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", integrations: [{ name: "slack", active: false }] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/integrations": [] });
    const result = await runReconcile({ config, client, cycles: [integrationsCycle], mode: "dry-run" });
    expect(result.cycles[0]!.counts).toEqual({ create: 0, update: 0, delete: 0 });
  });

  it("an UNDECLARED live integration is still ownership-gated (no delete without `owned`)", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", integrations: [] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/integrations": [{ slug: "jira", active: true }] });
    const result = await runReconcile({ config, client, cycles: [integrationsCycle], mode: "dry-run" });
    expect(result.cycles[0]!.counts.delete).toBe(0);
  });
});
