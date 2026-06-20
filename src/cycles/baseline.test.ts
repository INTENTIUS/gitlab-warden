import { describe, it, expect } from "vitest";
import { baselineCycle } from "./baseline.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const GROUP = "group:acme/platform";

describe("baselineCycle.fetchLive", () => {
  it("collects existing subgroup + project paths as children", async () => {
    const client = makeClient({}, {
      "/groups/acme%2Fplatform/subgroups": [{ path: "infra" }],
      "/groups/acme%2Fplatform/projects": [{ path: "api" }, { path: "web" }],
    });
    const live = await baselineCycle.fetchLive(client, GROUP, scope, makeBudget());
    expect((live.children ?? []).sort()).toEqual(["api", "infra", "web"]);
  });
  it("no-op on project nodes", async () => {
    const client = makeClient();
    expect(await baselineCycle.fetchLive(client, "project:acme/api", scope, makeBudget())).toEqual({});
  });
});

describe("baselineCycle.apply", () => {
  it("creates a subgroup with parent_id", async () => {
    const client = makeClient({ "GET /groups/acme%2Fplatform": { id: 5 } });
    await baselineCycle.apply(
      client,
      { kind: "create", resourceType: "baseline", key: "infra", after: { kind: "group", path: "infra", visibility: "private" } },
      GROUP,
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /groups/acme%2Fplatform", "POST /groups"]);
    expect(client.calls[1]!.body).toMatchObject({ name: "infra", path: "infra", parent_id: 5, visibility: "private" });
  });
  it("creates a project with namespace_id (+ template)", async () => {
    const client = makeClient({ "GET /groups/acme%2Fplatform": { id: 5 } });
    await baselineCycle.apply(
      client,
      { kind: "create", resourceType: "baseline", key: "svc", after: { kind: "project", path: "svc", template: "rails" } },
      GROUP,
      scope,
      makeBudget(),
    );
    expect(client.calls[1]).toMatchObject({ method: "POST", path: "/projects", body: { path: "svc", namespace_id: 5, template_name: "rails" } });
  });
});

describe("baselineCycle via runReconcile", () => {
  it("creates only the missing child", async () => {
    const config: GovernanceConfig = {
      nodes: { "acme/platform": { kind: "group", baselines: [{ kind: "project", path: "api" }, { kind: "project", path: "new" }] } },
    };
    const client = makeClient({ "GET /groups/acme%2Fplatform": { id: 5 } }, { "/groups/acme%2Fplatform/projects": [{ path: "api" }], "/groups/acme%2Fplatform/subgroups": [] });
    const result = await runReconcile({ config, client, cycles: [baselineCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.find((c) => c.method === "POST")!.body).toMatchObject({ path: "new" });
  });
});
