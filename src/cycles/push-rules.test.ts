import { describe, it, expect } from "vitest";
import { pushRulesCycle, buildPushRuleBody } from "./push-rules.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("buildPushRuleBody", () => {
  it("maps declared fields to GitLab snake_case", () => {
    expect(buildPushRuleBody({ preventSecrets: true, maxFileSize: 100, commitMessageRegex: "^JIRA" })).toEqual({
      prevent_secrets: true,
      max_file_size: 100,
      commit_message_regex: "^JIRA",
    });
  });
});

describe("pushRulesCycle.fetchLive", () => {
  it("maps project push rules", async () => {
    const client = makeClient({ "GET /projects/acme%2Fapi/push_rule": { prevent_secrets: true, max_file_size: 50 } });
    const live = await pushRulesCycle.fetchLive(client, "project:acme/api", scope, makeBudget());
    expect(live.pushRules).toEqual({ preventSecrets: true, maxFileSize: 50 });
  });
  it("reads group push rules from the group sub-resource", async () => {
    const client = makeClient({ "GET /groups/acme/push_rule": { member_check: true } });
    await pushRulesCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(client.calls[0]!.path).toBe("/groups/acme/push_rule");
  });
  it("tolerates 403 (Premium) and 404 (unset) → unmanaged", async () => {
    const c403 = makeClient({ "GET /projects/p/push_rule": () => { throw new Error("403 Forbidden"); } });
    expect(await pushRulesCycle.fetchLive(c403, "project:p", scope, makeBudget())).toEqual({});
    const c404 = makeClient({ "GET /projects/p/push_rule": () => { throw new Error("404 Not Found"); } });
    expect(await pushRulesCycle.fetchLive(c404, "project:p", scope, makeBudget())).toEqual({});
  });
});

describe("pushRulesCycle.apply", () => {
  it("POSTs on create (no rule yet)", async () => {
    const client = makeClient();
    await pushRulesCycle.apply(
      client,
      { kind: "create", resourceType: "push-rules", key: "push-rules", after: { preventSecrets: true } },
      "project:acme/api",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/push_rule", body: { prevent_secrets: true } });
  });
  it("PUTs on update (re-assert drift)", async () => {
    const client = makeClient();
    await pushRulesCycle.apply(
      client,
      { kind: "update", resourceType: "push-rules", key: "push-rules", after: { preventSecrets: true }, fields: [] },
      "group:acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/groups/acme/push_rule" });
  });
});

describe("pushRulesCycle via runReconcile — drift re-assertion", () => {
  it("re-asserts drifted push rules across multiple nodes", async () => {
    const config: GovernanceConfig = {
      nodes: {
        "acme/api": { kind: "project", pushRules: { preventSecrets: true } },
        "acme/web": { kind: "project", pushRules: { preventSecrets: true } },
      },
    };
    const client = makeClient({
      "GET /projects/acme%2Fapi/push_rule": { prevent_secrets: false }, // drifted → update
      "GET /projects/acme%2Fweb/push_rule": {}, // unset → create
    });
    const result = await runReconcile({ config, client, cycles: [pushRulesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    const writes = client.calls.filter((c) => c.method === "PUT" || c.method === "POST").map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual(expect.arrayContaining([
      "PUT /projects/acme%2Fapi/push_rule",
      "POST /projects/acme%2Fweb/push_rule",
    ]));
  });
});
