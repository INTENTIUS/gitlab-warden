import { describe, it, expect } from "vitest";
import { accessTokensCycle } from "./access-tokens.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJECT = "project:acme/api";

describe("accessTokensCycle.fetchLive", () => {
  it("keeps active, non-revoked tokens", async () => {
    const client = makeClient({}, {
      "/projects/acme%2Fapi/access_tokens": [
        { id: 1, name: "ci-bot", scopes: ["api"], access_level: 40, active: true },
        { id: 2, name: "old", revoked: true },
      ],
    });
    const live = await accessTokensCycle.fetchLive(client, PROJECT, scope, makeBudget());
    expect(live.accessTokens).toEqual([{ id: 1, name: "ci-bot", scopes: ["api"], accessLevel: 40, active: true }]);
  });
  it("uses /groups for group nodes", async () => {
    const client = makeClient({}, { "/groups/acme/access_tokens": [] });
    await accessTokensCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(client.calls[0]!.path).toBe("/groups/acme/access_tokens");
  });
});

describe("accessTokensCycle.apply", () => {
  it("create POSTs name/scopes/access_level (name↔number)", async () => {
    const client = makeClient();
    await accessTokensCycle.apply(
      client,
      { kind: "create", resourceType: "access-token", key: "ci-bot", after: { name: "ci-bot", scopes: ["api"], accessLevel: "maintainer" } },
      PROJECT,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/projects/acme%2Fapi/access_tokens", body: { name: "ci-bot", scopes: ["api"], access_level: 40 } });
  });
  it("delete revokes by id", async () => {
    const client = makeClient();
    await accessTokensCycle.apply(client, { kind: "delete", resourceType: "access-token", key: "old", before: { id: 2, name: "old" } }, PROJECT, scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/projects/acme%2Fapi/access_tokens/2" });
  });
});

describe("accessTokensCycle via runReconcile", () => {
  it("creates a missing bot token; revokes an owned one not in config", async () => {
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project", accessTokens: [{ name: "ci-bot", scopes: ["api"] }] } } };
    const client = makeClient({}, { "/projects/acme%2Fapi/access_tokens": [{ id: 5, name: "stale", active: true }] });
    const result = await runReconcile({ config, client, cycles: [accessTokensCycle], mode: "apply", diffOptions: { isOwned: () => true }, removalDeltaCapFraction: 1 });
    expect(result.completed).toBe(true);
    const muts = client.calls.filter((c) => c.method !== "PAGINATE").map((c) => `${c.method} ${c.path}`);
    expect(muts).toEqual(expect.arrayContaining(["POST /projects/acme%2Fapi/access_tokens", "DELETE /projects/acme%2Fapi/access_tokens/5"]));
  });
});
