import { describe, it, expect } from "vitest";
import { memberRolesCycle } from "./member-roles.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("memberRolesCycle.fetchLive", () => {
  it("reads group member roles", async () => {
    const client = makeClient({}, { "/groups/acme/member_roles": [{ id: 1, name: "auditor", base_access_level: 20, enabled_permissions: ["read_code"] }] });
    const live = await memberRolesCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(live.memberRoles).toEqual([{ id: 1, name: "auditor", baseAccessLevel: 20, permissions: ["read_code"] }]);
  });
  it("uses the instance endpoint for instance nodes; no-op for projects", async () => {
    const client = makeClient({}, { "/member_roles": [] });
    await memberRolesCycle.fetchLive(client, "instance:@instance", scope, makeBudget());
    expect(client.calls[0]!.path).toBe("/member_roles");
    expect(await memberRolesCycle.fetchLive(makeClient(), "project:acme/api", scope, makeBudget())).toEqual({});
  });
  it("tolerates 403 (Ultimate)", async () => {
    const client = makeClient();
    client.paginate = async () => { throw new Error("403 Forbidden"); };
    expect(await memberRolesCycle.fetchLive(client, "group:acme", scope, makeBudget())).toEqual({});
  });
});

describe("memberRolesCycle.apply", () => {
  it("create POSTs name/base_access_level/permissions (name↔number)", async () => {
    const client = makeClient();
    await memberRolesCycle.apply(client, { kind: "create", resourceType: "member-role", key: "auditor", after: { name: "auditor", baseAccessLevel: "reporter", permissions: ["read_code"] } }, "group:acme", scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/groups/acme/member_roles", body: { name: "auditor", base_access_level: 20, permissions: ["read_code"] } });
  });
  it("delete DELETEs by id", async () => {
    const client = makeClient();
    await memberRolesCycle.apply(client, { kind: "delete", resourceType: "member-role", key: "auditor", before: { id: 1, name: "auditor" } }, "group:acme", scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/groups/acme/member_roles/1" });
  });
});

describe("memberRolesCycle via runReconcile", () => {
  it("creates a missing role", async () => {
    const config: GovernanceConfig = { nodes: { acme: { kind: "group", memberRoles: [{ name: "auditor", baseAccessLevel: 20 }] } } };
    const client = makeClient({}, { "/groups/acme/member_roles": [] });
    const result = await runReconcile({ config, client, cycles: [memberRolesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
  });
});
