import { describe, it, expect } from "vitest";
import { projectSettingsCycle, buildProjectBody } from "./project-settings.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/platform/api";

describe("buildProjectBody", () => {
  it("maps declared fields incl. topics inline", () => {
    expect(buildProjectBody({ mergeMethod: "ff", removeSourceBranchAfterMerge: true, topics: ["go"] })).toEqual({
      merge_method: "ff",
      remove_source_branch_after_merge: true,
      topics: ["go"],
    });
  });
});

describe("projectSettingsCycle.fetchLive", () => {
  it("GETs the project and maps settings + topics", async () => {
    const client = makeClient({
      "GET /projects/acme%2Fplatform%2Fapi": { description: "svc", merge_method: "rebase_merge", topics: ["go"] },
    });
    const live = await projectSettingsCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.projectSettings).toEqual({ description: "svc", mergeMethod: "rebase_merge", topics: ["go"] });
  });
  it("is a no-op on group nodes", async () => {
    const client = makeClient();
    expect(await projectSettingsCycle.fetchLive(client, "group:acme", scope, makeBudget())).toEqual({});
    expect(client.calls).toHaveLength(0);
  });
});

describe("projectSettingsCycle.apply", () => {
  it("PUTs settings + topics in one call", async () => {
    const client = makeClient();
    await projectSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "project-settings", key: "project-settings", after: { description: "new", topics: ["a", "b"] }, fields: [] },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/projects/acme%2Fplatform%2Fapi", body: { description: "new", topics: ["a", "b"] } });
  });
});

describe("projectSettingsCycle via runReconcile", () => {
  it("updates a drifted project setting", async () => {
    const config: GovernanceConfig = { nodes: { "acme/platform/api": { kind: "project", projectSettings: { mergeMethod: "ff" } } } };
    const client = makeClient({ "GET /projects/acme%2Fplatform%2Fapi": { merge_method: "merge" } });
    const result = await runReconcile({ config, client, cycles: [projectSettingsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PUT")!.body).toEqual({ merge_method: "ff" });
  });
});
