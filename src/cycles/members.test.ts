import { describe, it, expect } from "vitest";
import { membersCycle } from "./members.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const GROUP = "group:acme/platform";
const directMembers = [
  { id: 1, username: "alice", access_level: 30 },
  { id: 2, username: "bob", access_level: 40 },
];

describe("membersCycle.fetchLive", () => {
  it("reads the DIRECT roster (/members, not /members/all) and maps it", async () => {
    const client = makeClient({}, { "/groups/acme%2Fplatform/members": directMembers });
    const live = await membersCycle.fetchLive(client, GROUP, scope, makeBudget());
    expect(live.members).toEqual([
      { userId: 1, username: "alice", accessLevel: 30 },
      { userId: 2, username: "bob", accessLevel: 40 },
    ]);
    // crucially: the paginated path is /members, never /members/all
    expect(client.calls.find((c) => c.method === "PAGINATE")!.path).toBe("/groups/acme%2Fplatform/members");
  });
  it("uses /projects for project nodes", async () => {
    const client = makeClient({}, { "/projects/acme%2Fapi/members": [] });
    await membersCycle.fetchLive(client, "project:acme/api", scope, makeBudget());
    expect(client.calls[0]!.path).toBe("/projects/acme%2Fapi/members");
  });
});

describe("membersCycle.apply", () => {
  it("create resolves username → id then POSTs", async () => {
    const client = makeClient({ "GET /users?username=carol": [{ id: 9 }] });
    await membersCycle.apply(
      client,
      { kind: "create", resourceType: "member", key: "carol", after: { user: "carol", accessLevel: "developer" } },
      GROUP,
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /users?username=carol",
      "POST /groups/acme%2Fplatform/members",
    ]);
    expect(client.calls[1]!.body).toEqual({ user_id: 9, access_level: 30 });
  });
  it("create with a numeric user skips resolution", async () => {
    const client = makeClient();
    await membersCycle.apply(
      client,
      { kind: "create", resourceType: "member", key: "9", after: { user: 9, accessLevel: 40 } },
      GROUP,
      scope,
      makeBudget(),
    );
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ method: "POST", body: { user_id: 9, access_level: 40 } });
  });
  it("update PUTs the new access level by user id", async () => {
    const client = makeClient();
    await membersCycle.apply(
      client,
      { kind: "update", resourceType: "member", key: "alice", before: { userId: 1, username: "alice", accessLevel: 30 }, after: { user: "alice", accessLevel: "maintainer" }, fields: [] },
      GROUP,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/groups/acme%2Fplatform/members/1", body: { access_level: 40 } });
  });
  it("delete DELETEs the direct member by user id", async () => {
    const client = makeClient();
    await membersCycle.apply(
      client,
      { kind: "delete", resourceType: "member", key: "bob", before: { userId: 2, username: "bob", accessLevel: 40 } },
      GROUP,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/groups/acme%2Fplatform/members/2" });
  });
});

describe("membersCycle via runReconcile — inheritance safety", () => {
  it("access drift updates; an owned direct member not in config is removed; an inherited member is never touched", async () => {
    // Direct roster: alice, bob. Config: alice (maintainer). carol is INHERITED
    // from an ancestor — she is NOT in the direct roster, so she must never be
    // deleted (the DELETE would 404).
    const config: GovernanceConfig = {
      nodes: { "acme/platform": { kind: "group", members: [{ user: "alice", accessLevel: "maintainer" }] } },
    };
    const client = makeClient({}, { "/groups/acme%2Fplatform/members": directMembers });
    const result = await runReconcile({
      config,
      client,
      cycles: [membersCycle],
      mode: "apply",
      diffOptions: { isOwned: () => true },
      removalDeltaCapFraction: 1,
    });
    expect(result.completed).toBe(true);
    const mutations = client.calls.filter((c) => c.method !== "PAGINATE").map((c) => `${c.method} ${c.path}`);
    // alice updated to maintainer, bob removed — nothing references carol
    expect(mutations).toEqual(["PUT /groups/acme%2Fplatform/members/1", "DELETE /groups/acme%2Fplatform/members/2"]);
    expect(mutations.some((m) => m.includes("carol"))).toBe(false);
  });
});
