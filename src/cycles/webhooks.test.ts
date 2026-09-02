import { describe, it, expect } from "vitest";
import { webhooksCycle, buildHookBody } from "./webhooks.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import { diff } from "../reconcile/diff.js";
import type { GovernanceConfig, NodeConfig } from "../config/types.js";
import type { LiveNodeState } from "../reconcile/live.js";

const scope = {};

describe("buildHookBody", () => {
  it("maps events; url only when included", () => {
    const w = { url: "https://h", pushEvents: true, enableSslVerification: false };
    expect(buildHookBody(w, true)).toEqual({ url: "https://h", push_events: true, enable_ssl_verification: false });
    expect(buildHookBody(w, false)).not.toHaveProperty("url");
  });
});

describe("webhooksCycle.fetchLive", () => {
  it("maps hooks carrying the id, group + project", async () => {
    const client = makeClient({}, { "/groups/acme/hooks": [{ id: 3, url: "https://org", push_events: true }] });
    const live = await webhooksCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(live.webhooks).toEqual([{ id: 3, url: "https://org", pushEvents: true }]);
    const pc = makeClient({}, { "/projects/acme%2Fapi/hooks": [] });
    await webhooksCycle.fetchLive(pc, "project:acme/api", scope, makeBudget());
    expect(pc.calls[0]!.path).toBe("/projects/acme%2Fapi/hooks");
  });
});

describe("webhooksCycle.apply", () => {
  it("create POSTs with url", async () => {
    const client = makeClient();
    await webhooksCycle.apply(
      client,
      { kind: "create", resourceType: "webhook", key: "https://h", after: { url: "https://h", pushEvents: true } },
      "group:acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/groups/acme/hooks", body: { url: "https://h", push_events: true } });
  });
  it("update PUTs by live id", async () => {
    const client = makeClient();
    await webhooksCycle.apply(
      client,
      { kind: "update", resourceType: "webhook", key: "https://h", before: { id: 9, url: "https://h" }, after: { url: "https://h", pushEvents: false }, fields: [] },
      "project:acme/api",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/projects/acme%2Fapi/hooks/9", body: { push_events: false } });
  });
  it("delete DELETEs by id; throws without a live id", async () => {
    const client = makeClient();
    await webhooksCycle.apply(client, { kind: "delete", resourceType: "webhook", key: "https://h", before: { id: 3, url: "https://h" } }, "group:acme", scope, makeBudget());
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/groups/acme/hooks/3" });
    await expect(
      webhooksCycle.apply(client, { kind: "delete", resourceType: "webhook", key: "https://h", before: { url: "https://h" } }, "group:acme", scope, makeBudget()),
    ).rejects.toThrow(/no live id/);
  });
});

describe("webhook previously: rename", () => {
  it("plans exactly one update keyed by the new URL, live id on before — no delete + create", () => {
    const desired: NodeConfig = {
      kind: "group",
      webhooks: [{ url: "https://new", previously: "https://old", pushEvents: true }],
    };
    const live: LiveNodeState = { webhooks: [{ id: 9, url: "https://old", pushEvents: false }] };
    const cs = diff("group:acme", desired, live, { isOwned: () => true });
    expect(cs.entries).toHaveLength(1);
    const e = cs.entries[0]!;
    expect(e.kind).toBe("update");
    expect(e.key).toBe("https://new");
    expect((e.before as { id?: number }).id).toBe(9);
    expect(e.fields).toContainEqual({ field: "key", before: "https://old", after: "https://new" });
    expect(e.fields).toContainEqual({ field: "pushEvents", before: false, after: true });
  });

  it("a stale alias (no live hook at the old URL) falls back to a create", () => {
    const desired: NodeConfig = {
      kind: "group",
      webhooks: [{ url: "https://new", previously: "https://old" }],
    };
    const cs = diff("group:acme", desired, { webhooks: [] }, {});
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("create");
    expect(cs.entries[0]!.key).toBe("https://new");
  });

  it("an alias whose new URL is already live is inert (normal diff, old URL undeclared)", () => {
    const desired: NodeConfig = {
      kind: "group",
      webhooks: [{ url: "https://new", previously: "https://old", pushEvents: true }],
    };
    const live: LiveNodeState = {
      webhooks: [
        { id: 1, url: "https://new", pushEvents: true },
        { id: 9, url: "https://old" },
      ],
    };
    const cs = diff("group:acme", desired, live, {});
    expect(cs.entries).toEqual([]); // converged; the old hook is undeclared and unowned
  });

  it("applies the rename as one PUT by live id, carrying the new URL", async () => {
    const client = makeClient();
    await webhooksCycle.apply(
      client,
      {
        kind: "update",
        resourceType: "webhook",
        key: "https://new",
        before: { id: 9, url: "https://old" },
        after: { url: "https://new", previously: "https://old" },
        fields: [{ field: "key", before: "https://old", after: "https://new" }],
      },
      "group:acme",
      {},
      makeBudget(),
    );
    expect(client.calls).toEqual([
      { method: "PUT", path: "/groups/acme/hooks/9", body: { url: "https://new" } },
    ]);
  });

  it("system hooks ignore previously: — delete + create stays honest (no update endpoint)", () => {
    const desired: NodeConfig = {
      kind: "instance",
      systemHooks: [{ url: "https://new", previously: "https://old" }],
    };
    const live: LiveNodeState = { systemHooks: [{ id: 9, url: "https://old" }] };
    const cs = diff("instance:lab", desired, live, { isOwned: () => true });
    expect(cs.entries.map((e) => e.kind).sort()).toEqual(["create", "delete"]);
  });
});

describe("webhooksCycle via runReconcile", () => {
  it("creates a missing webhook", async () => {
    const config: GovernanceConfig = { nodes: { acme: { kind: "group", webhooks: [{ url: "https://new", pushEvents: true }] } } };
    const client = makeClient({}, { "/groups/acme/hooks": [] });
    const result = await runReconcile({ config, client, cycles: [webhooksCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.find((c) => c.method === "POST")!.path).toBe("/groups/acme/hooks");
  });
});
