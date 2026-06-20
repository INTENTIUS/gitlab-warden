import { describe, it, expect } from "vitest";
import { deployKeysTokensCycle } from "./deploy-keys-tokens.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("deployKeysTokensCycle.fetchLive", () => {
  it("reads deploy keys (project) + tokens", async () => {
    const client = makeClient({}, {
      "/projects/acme%2Fapi/deploy_keys": [{ id: 1, title: "ci", can_push: true }],
      "/projects/acme%2Fapi/deploy_tokens": [{ id: 7, name: "registry", scopes: ["read_registry"] }],
    });
    const live = await deployKeysTokensCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.deployKeys).toEqual([{ id: 1, title: "ci", canPush: true }]);
    expect(live.deployTokens).toEqual([{ id: 7, name: "registry", scopes: ["read_registry"] }]);
  });
  it("group nodes have tokens but no deploy keys", async () => {
    const client = makeClient({}, { "/groups/acme/deploy_tokens": [] });
    const live = await deployKeysTokensCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(live.deployKeys).toBeUndefined();
    expect(client.calls[0]!.path).toBe("/groups/acme/deploy_tokens");
  });
});

describe("deployKeysTokensCycle.apply — deploy keys", () => {
  it("create POSTs title+key+can_push", async () => {
    const client = makeClient();
    await deployKeysTokensCycle.apply(client, { kind: "create", resourceType: "deploy-key", key: "ci", after: { title: "ci", key: "ssh-ed25519 AAA", canPush: true } }, PROJECT, scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/deploy_keys", body: { title: "ci", key: "ssh-ed25519 AAA", can_push: true } });
  });
  it("update PUTs can_push by id; delete DELETEs by id", async () => {
    const c1 = makeClient();
    await deployKeysTokensCycle.apply(c1, { kind: "update", resourceType: "deploy-key", key: "ci", before: { id: 1, title: "ci" }, after: { title: "ci", key: "x", canPush: false }, fields: [] }, PROJECT, scope, makeBudget());
    expect(c1.calls[0]).toMatchObject({ method: "PUT", path: "/projects/acme%2Fapi/deploy_keys/1", body: { can_push: false } });
    const c2 = makeClient();
    await deployKeysTokensCycle.apply(c2, { kind: "delete", resourceType: "deploy-key", key: "ci", before: { id: 1, title: "ci" } }, PROJECT, scope, makeBudget());
    expect(c2.calls[0]).toMatchObject({ method: "DELETE", path: "/projects/acme%2Fapi/deploy_keys/1" });
  });
});

describe("deployKeysTokensCycle.apply — deploy tokens", () => {
  it("create POSTs; delete DELETEs by id; no update path", async () => {
    const c1 = makeClient();
    await deployKeysTokensCycle.apply(c1, { kind: "create", resourceType: "deploy-token", key: "registry", after: { name: "registry", scopes: ["read_registry"] } }, "group:acme", scope, makeBudget());
    expect(c1.calls[0]).toMatchObject({ method: "POST", path: "/groups/acme/deploy_tokens", body: { name: "registry", scopes: ["read_registry"] } });
    const c2 = makeClient();
    await deployKeysTokensCycle.apply(c2, { kind: "delete", resourceType: "deploy-token", key: "registry", before: { id: 7, name: "registry" } }, "group:acme", scope, makeBudget());
    expect(c2.calls[0]).toMatchObject({ method: "DELETE", path: "/groups/acme/deploy_tokens/7" });
  });
});

describe("deployKeysTokensCycle via runReconcile", () => {
  it("creates a missing token and key", async () => {
    const config: GovernanceConfig = {
      nodes: { "acme/api": { kind: "project", deployKeys: [{ title: "ci", key: "k" }], deployTokens: [{ name: "reg" }] } },
    };
    const client = makeClient({}, { "/projects/acme%2Fapi/deploy_keys": [], "/projects/acme%2Fapi/deploy_tokens": [] });
    const result = await runReconcile({ config, client, cycles: [deployKeysTokensCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(2);
  });
});
