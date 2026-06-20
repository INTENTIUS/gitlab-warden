import { describe, it, expect } from "vitest";
import { instanceGovernanceCycle } from "./instance-governance.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const INSTANCE = "instance:@instance";

describe("instanceGovernanceCycle.fetchLive", () => {
  it("reads settings, system hooks, and instance variables", async () => {
    const client = makeClient(
      { "GET /application/settings": { signup_enabled: false } },
      { "/hooks": [{ id: 1, url: "https://h", push_events: true }], "/admin/ci/variables": [{ key: "GLOBAL", value: "x" }] },
    );
    const live = await instanceGovernanceCycle.fetchLive(client, INSTANCE, scope, makeBudget());
    expect(live.instanceSettings).toEqual({ signup_enabled: false });
    expect(live.systemHooks).toEqual([{ id: 1, url: "https://h", pushEvents: true }]);
    expect(live.instanceVariables).toEqual([{ key: "GLOBAL", value: "x" }]);
  });
  it("is a no-op on group/project nodes", async () => {
    expect(await instanceGovernanceCycle.fetchLive(makeClient(), "group:acme", scope, makeBudget())).toEqual({});
  });
  it("tolerates 403 (non-admin / SaaS)", async () => {
    const client = makeClient({ "GET /application/settings": () => { throw new Error("403 Forbidden"); } });
    client.paginate = async () => { throw new Error("403 Forbidden"); };
    const live = await instanceGovernanceCycle.fetchLive(client, INSTANCE, scope, makeBudget());
    expect(live).toEqual({});
  });
});

describe("instanceGovernanceCycle.apply", () => {
  it("instance-settings → PUT /application/settings", async () => {
    const client = makeClient();
    await instanceGovernanceCycle.apply(client, { kind: "update", resourceType: "instance-settings", key: "instance-settings", after: { signup_enabled: false }, fields: [] }, INSTANCE, scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/application/settings", body: { signup_enabled: false } });
  });
  it("system-hook create POSTs; delete DELETEs by id", async () => {
    const c1 = makeClient();
    await instanceGovernanceCycle.apply(c1, { kind: "create", resourceType: "system-hook", key: "https://h", after: { url: "https://h", pushEvents: true } }, INSTANCE, scope, makeBudget());
    expect(c1.calls[0]).toMatchObject({ method: "POST", path: "/hooks", body: { url: "https://h", push_events: true } });
    const c2 = makeClient();
    await instanceGovernanceCycle.apply(c2, { kind: "delete", resourceType: "system-hook", key: "https://h", before: { id: 4, url: "https://h" } }, INSTANCE, scope, makeBudget());
    expect(c2.calls[0]).toMatchObject({ method: "DELETE", path: "/hooks/4" });
  });
  it("instance-variable create/delete on /admin/ci/variables", async () => {
    const c1 = makeClient();
    await instanceGovernanceCycle.apply(c1, { kind: "create", resourceType: "instance-variable", key: "GLOBAL@*", after: { key: "GLOBAL", value: "v" } }, INSTANCE, scope, makeBudget());
    expect(c1.calls[0]).toMatchObject({ method: "POST", path: "/admin/ci/variables", body: { key: "GLOBAL", value: "v" } });
    const c2 = makeClient();
    await instanceGovernanceCycle.apply(c2, { kind: "delete", resourceType: "instance-variable", key: "OLD@*", before: { key: "OLD" } }, INSTANCE, scope, makeBudget());
    expect(c2.calls[0]).toMatchObject({ method: "DELETE", path: "/admin/ci/variables/OLD" });
  });
});

describe("instanceGovernanceCycle via runReconcile", () => {
  it("reconciles a drifted instance setting", async () => {
    const config: GovernanceConfig = { nodes: { "@instance": { kind: "instance", instanceSettings: { signup_enabled: false } } } };
    const client = makeClient({ "GET /application/settings": { signup_enabled: true } }, { "/hooks": [], "/admin/ci/variables": [] });
    const result = await runReconcile({ config, client, cycles: [instanceGovernanceCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PUT")!.body).toEqual({ signup_enabled: false });
  });
});
