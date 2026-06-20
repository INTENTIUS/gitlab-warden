import { describe, it, expect } from "vitest";
import { advancedProtectionsCycle } from "./advanced-protections.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("advancedProtectionsCycle.fetchLive", () => {
  it("maps job_token_scope inbound_enabled", async () => {
    const client = makeClient({ "GET /projects/acme%2Fapi/job_token_scope": { inbound_enabled: true } });
    const live = await advancedProtectionsCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.jobTokenScope).toEqual({ inboundEnabled: true });
  });
  it("no-op on group nodes; tolerates 403/404", async () => {
    expect(await advancedProtectionsCycle.fetchLive(makeClient(), "group:acme", scope, makeBudget())).toEqual({});
    const c = makeClient({ "GET /projects/acme%2Fapi/job_token_scope": () => { throw new Error("404 Not Found"); } });
    expect(await advancedProtectionsCycle.fetchLive(c, PROJECT, scope, makeBudget())).toEqual({});
  });
});

describe("advancedProtectionsCycle.apply", () => {
  it("PATCHes job_token_scope { enabled }", async () => {
    const client = makeClient();
    await advancedProtectionsCycle.apply(
      client,
      { kind: "update", resourceType: "job-token-scope", key: "job-token-scope", after: { inboundEnabled: false }, fields: [] },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PATCH", path: "/projects/acme%2Fapi/job_token_scope", body: { enabled: false } });
  });
});

describe("advancedProtectionsCycle via runReconcile", () => {
  it("reconciles drifted inbound enforcement", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", jobTokenScope: { inboundEnabled: true } } } };
    const client = makeClient({ "GET /projects/acme%2Fapi/job_token_scope": { inbound_enabled: false } });
    const result = await runReconcile({ config, client, cycles: [advancedProtectionsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PATCH")!.body).toEqual({ enabled: true });
  });
});
