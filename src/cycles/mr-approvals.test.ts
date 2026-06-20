import { describe, it, expect } from "vitest";
import { mrApprovalsCycle, buildRuleBody, buildSettingsBody } from "./mr-approvals.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("body builders", () => {
  it("rule body includes name only on create", () => {
    expect(buildRuleBody({ name: "sec", approvalsRequired: 2, userIds: [1] }, true)).toEqual({ name: "sec", approvals_required: 2, user_ids: [1] });
    expect(buildRuleBody({ name: "sec", approvalsRequired: 2 }, false)).toEqual({ approvals_required: 2 });
  });
  it("settings body maps camel→snake", () => {
    expect(buildSettingsBody({ mergeRequestsAuthorApproval: false, resetApprovalsOnPush: true })).toEqual({
      merge_requests_author_approval: false,
      reset_approvals_on_push: true,
    });
  });
});

describe("mrApprovalsCycle.fetchLive", () => {
  it("maps rules (id + member ids) and settings", async () => {
    const client = makeClient(
      { "GET /projects/acme%2Fapi/approvals": { merge_requests_author_approval: false } },
      { "/projects/acme%2Fapi/approval_rules": [{ id: 7, name: "sec", approvals_required: 2, users: [{ id: 1 }], protected_branches: [{ id: 3 }] }] },
    );
    const live = await mrApprovalsCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.approvalRules).toEqual([{ id: 7, name: "sec", approvalsRequired: 2, userIds: [1], protectedBranchIds: [3] }]);
    expect(live.approvalSettings).toEqual({ mergeRequestsAuthorApproval: false });
  });
  it("tolerates 403 on rules (Premium)", async () => {
    const client = makeClient({
      "GET /projects/acme%2Fapi/approvals": { reset_approvals_on_push: true },
    });
    // approval_rules paginate returns [] by default; force settings-only by 403 on rules
    const c2 = makeClient({
      "GET /projects/acme%2Fapi/approvals": { reset_approvals_on_push: true },
    });
    c2.paginate = async () => { throw new Error("403 Forbidden"); };
    const live = await mrApprovalsCycle.fetchLive(c2, PROJECT, scope, makeBudget());
    expect(live.approvalRules).toBeUndefined();
    expect(live.approvalSettings).toEqual({ resetApprovalsOnPush: true });
    void client;
  });
  it("no-op on group nodes", async () => {
    const client = makeClient();
    expect(await mrApprovalsCycle.fetchLive(client, "group:acme", scope, makeBudget())).toEqual({});
  });
});

describe("mrApprovalsCycle.apply", () => {
  it("settings → POST /approvals", async () => {
    const client = makeClient();
    await mrApprovalsCycle.apply(
      client,
      { kind: "update", resourceType: "approval-settings", key: "approval-settings", after: { mergeRequestsAuthorApproval: false }, fields: [] },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/approvals", body: { merge_requests_author_approval: false } });
  });
  it("rule create POSTs, update/delete use the live id", async () => {
    const c1 = makeClient();
    await mrApprovalsCycle.apply(c1, { kind: "create", resourceType: "approval-rule", key: "sec", after: { name: "sec", approvalsRequired: 2 } }, PROJECT, scope, makeBudget());
    expect(c1.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/approval_rules", body: { name: "sec", approvals_required: 2 } });

    const c2 = makeClient();
    await mrApprovalsCycle.apply(c2, { kind: "update", resourceType: "approval-rule", key: "sec", before: { id: 7, name: "sec" }, after: { name: "sec", approvalsRequired: 3 }, fields: [] }, PROJECT, scope, makeBudget());
    expect(c2.calls[0]).toMatchObject({ method: "PUT", path: "/projects/acme%2Fapi/approval_rules/7" });

    const c3 = makeClient();
    await mrApprovalsCycle.apply(c3, { kind: "delete", resourceType: "approval-rule", key: "sec", before: { id: 7, name: "sec" } }, PROJECT, scope, makeBudget());
    expect(c3.calls[0]).toMatchObject({ method: "DELETE", path: "/projects/acme%2Fapi/approval_rules/7" });
  });
});

describe("mrApprovalsCycle via runReconcile", () => {
  it("creates a missing rule and updates settings", async () => {
    const config: GovernanceConfig = {
      nodes: { "acme/api": { kind: "project", approvalRules: [{ name: "sec", approvalsRequired: 2 }], approvalSettings: { mergeRequestsAuthorApproval: false } } },
    };
    const client = makeClient({ "GET /projects/acme%2Fapi/approvals": { merge_requests_author_approval: true } }, { "/projects/acme%2Fapi/approval_rules": [] });
    const result = await runReconcile({ config, client, cycles: [mrApprovalsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    const writes = client.calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(writes).toEqual(expect.arrayContaining(["/projects/acme%2Fapi/approval_rules", "/projects/acme%2Fapi/approvals"]));
  });
});
