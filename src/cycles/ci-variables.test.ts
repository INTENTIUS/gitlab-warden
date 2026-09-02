import { describe, it, expect } from "vitest";
import { ciVariablesCycle } from "./ci-variables.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("ciVariablesCycle.fetchLive", () => {
  it("paginates group variables and maps them", async () => {
    const client = makeClient({}, {
      "/groups/acme/variables": [{ key: "TOKEN", value: "x", environment_scope: "*", masked: true }],
    });
    const live = await ciVariablesCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(live.variables).toEqual([{ key: "TOKEN", value: "x", environmentScope: "*", masked: true }]);
  });
  it("uses /projects for project nodes", async () => {
    const client = makeClient({}, { "/projects/acme%2Fapi/variables": [] });
    await ciVariablesCycle.fetchLive(client, "project:acme/api", scope, makeBudget());
    expect(client.calls[0]!.path).toBe("/projects/acme%2Fapi/variables");
  });
});

describe("ciVariablesCycle.apply", () => {
  it("create POSTs key/value/scope/flags", async () => {
    const client = makeClient();
    await ciVariablesCycle.apply(
      client,
      { kind: "create", resourceType: "variable", key: "TOKEN@prod", after: { key: "TOKEN", value: "v", environmentScope: "prod", masked: true } },
      "project:acme/api",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/projects/acme%2Fapi/variables",
      body: { key: "TOKEN", value: "v", environment_scope: "prod", masked: true },
    });
  });
  it("create sources value from GITLAB_VAR_<KEY> when absent", async () => {
    process.env.GITLAB_VAR_SECRET = "from-env";
    const client = makeClient();
    await ciVariablesCycle.apply(
      client,
      { kind: "create", resourceType: "variable", key: "SECRET@*", after: { key: "SECRET", environmentScope: "*" } },
      "group:acme",
      scope,
      makeBudget(),
    );
    expect((client.calls[0]!.body as { value: string }).value).toBe("from-env");
    delete process.env.GITLAB_VAR_SECRET;
  });
  it("update PUTs with the environment_scope filter", async () => {
    const client = makeClient();
    await ciVariablesCycle.apply(
      client,
      { kind: "update", resourceType: "variable", key: "TOKEN@prod", before: {}, after: { key: "TOKEN", value: "new", environmentScope: "prod" }, fields: [] },
      "project:acme/api",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({
      method: "PUT",
      path: "/projects/acme%2Fapi/variables/TOKEN?filter[environment_scope]=prod",
      body: { value: "new" },
    });
  });
  it("delete DELETEs with the filter", async () => {
    const client = makeClient();
    await ciVariablesCycle.apply(
      client,
      { kind: "delete", resourceType: "variable", key: "OLD@*", before: { key: "OLD" } },
      "group:acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/groups/acme/variables/OLD?filter[environment_scope]=*" });
  });
});

describe("ciVariablesCycle.buildDesired", () => {
  it("resolves an omitted value from GITLAB_VAR_<KEY> so drift in it is diffed", () => {
    process.env.GITLAB_VAR_SECRET = "from-env";
    const desired = ciVariablesCycle.buildDesired(
      { kind: "group", variables: [{ key: "SECRET" }, { key: "PLAIN", value: "x" }] },
      "group:acme",
      scope,
    );
    expect(desired.variables).toEqual([{ key: "SECRET", value: "from-env" }, { key: "PLAIN", value: "x" }]);
    delete process.env.GITLAB_VAR_SECRET;
  });
  it("leaves value unset when neither config nor env provides one (presence-only)", () => {
    const desired = ciVariablesCycle.buildDesired({ kind: "group", variables: [{ key: "UNSET" }] }, "group:acme", scope);
    expect(desired.variables).toEqual([{ key: "UNSET" }]);
  });
});

describe("ciVariablesCycle via runReconcile", () => {
  it("corrects drift in an env-sourced value (GITLAB_VAR_<KEY>)", async () => {
    process.env.GITLAB_VAR_SECRET = "correct";
    const config: GovernanceConfig = { nodes: { acme: { kind: "group", variables: [{ key: "SECRET" }] } } };
    const client = makeClient({}, { "/groups/acme/variables": [{ key: "SECRET", value: "drifted" }] });
    const result = await runReconcile({ config, client, cycles: [ciVariablesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PUT")!.body).toMatchObject({ value: "correct" });
    delete process.env.GITLAB_VAR_SECRET;
  });
  it("updates a drifted variable value", async () => {
    const config: GovernanceConfig = { nodes: { acme: { kind: "group", variables: [{ key: "ENV", value: "prod" }] } } };
    const client = makeClient({}, { "/groups/acme/variables": [{ key: "ENV", value: "staging" }] });
    const result = await runReconcile({ config, client, cycles: [ciVariablesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PUT")!.body).toMatchObject({ value: "prod" });
  });
});
