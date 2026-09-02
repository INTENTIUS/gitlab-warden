/**
 * Runner integration — warden's runReconcile (chant harness + GitLab diff +
 * guardrails) driven with a fake cycle and a mock client, plus the scope-id
 * helpers.
 */

import { describe, it, expect } from "vitest";
import { removalDeltaCap } from "@intentius/chant/reconcile";
import { runReconcile, parseScope, nodeScopeId, type Cycle } from "./runner.js";
import { diff } from "./diff.js";
import { noteGatedSlice } from "../cycles/_shared.js";
import type { GitLabClient } from "../auth/client.js";
import type { NodeConfig, GovernanceConfig } from "../config/types.js";
import type { LiveNodeState } from "./live.js";

const mockClient = (): GitLabClient => ({
  async request<T = unknown>(): Promise<T> {
    return {} as T;
  },
  async paginate<T = unknown>(): Promise<T[]> {
    return [];
  },
  async graphql<T = unknown>(): Promise<T> {
    return {} as T;
  },
});

/** A members cycle: fetchLive returns the given live; buildDesired passes members through. */
function membersCycle(live: LiveNodeState, applied: string[]): Cycle {
  return {
    name: "members",
    async fetchLive() {
      return live;
    },
    buildDesired(config: NodeConfig) {
      return { kind: config.kind, members: config.members };
    },
    async apply(_client, entry) {
      applied.push(entry.key);
    },
  };
}

const cfg = (users: string[]): GovernanceConfig => ({
  nodes: { "acme/platform": { kind: "group", members: users.map((user) => ({ user, accessLevel: 30 })) } },
});

describe("scope id helpers", () => {
  it("round-trips kind + path", () => {
    expect(nodeScopeId("project", "acme/platform/api")).toBe("project:acme/platform/api");
    expect(parseScope("project:acme/platform/api")).toEqual({ kind: "project", path: "acme/platform/api" });
  });
});

describe("runReconcile (GitLab adapter)", () => {
  it("dry-run reports creates and applies nothing", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["a", "b", "c"]),
      client: mockClient(),
      cycles: [membersCycle({}, applied)], // empty live → all creates
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(3);
    expect(result.cycles[0]!.org).toBe("group:acme/platform"); // kind-prefixed scope id
    expect(applied).toHaveLength(0);
  });

  it("apply applies each entry", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["a", "b"]),
      client: mockClient(),
      cycles: [membersCycle({}, applied)],
      mode: "apply",
    });
    expect(result.completed).toBe(true);
    expect(applied.sort()).toEqual(["a", "b"]);
  });

  it("derives isOwned from a node's `owned: true` — a live-only entry becomes a delete", async () => {
    const applied: string[] = [];
    const live: LiveNodeState = {
      members: [
        { userId: 1, username: "a", accessLevel: 30 },
        { userId: 9, username: "stray", accessLevel: 30 },
      ],
    };
    const result = await runReconcile({
      config: { nodes: { "acme/platform": { kind: "group", owned: true, members: [{ user: "a", accessLevel: 30 }] } } },
      client: mockClient(),
      cycles: [membersCycle(live, applied)],
      mode: "dry-run",
    });
    const cr = result.cycles[0]!;
    expect(cr.counts.delete).toBe(1);
    expect(cr.plan).toContain("[member] stray");
  });

  it("plans no deletes when `owned` is absent (the default)", async () => {
    const applied: string[] = [];
    const live: LiveNodeState = {
      members: [
        { userId: 1, username: "a", accessLevel: 30 },
        { userId: 9, username: "stray", accessLevel: 30 },
      ],
    };
    const result = await runReconcile({
      config: cfg(["a"]),
      client: mockClient(),
      cycles: [membersCycle(live, applied)],
      mode: "dry-run",
    });
    expect(result.cycles[0]!.counts.delete).toBe(0);
  });

  it("owned: [types] unlocks deletes for the listed resource types only", async () => {
    // A cycle spanning two collections, so the type filter is observable.
    const live: LiveNodeState = {
      members: [{ userId: 9, username: "stray", accessLevel: 30 }],
      webhooks: [{ id: 7, url: "https://old.example.com/hook" }],
    };
    const twoSliceCycle: Cycle = {
      name: "two-slice",
      async fetchLive() {
        return live;
      },
      buildDesired(config: NodeConfig) {
        return { kind: config.kind, members: config.members, webhooks: config.webhooks };
      },
      async apply() {},
    };
    const result = await runReconcile({
      config: {
        nodes: { "acme/platform": { kind: "group", owned: ["webhook"], members: [], webhooks: [] } },
      },
      client: mockClient(),
      cycles: [twoSliceCycle],
      mode: "dry-run",
    });
    const cr = result.cycles[0]!;
    expect(cr.counts.delete).toBe(1);
    expect(cr.plan).toContain("[webhook] https://old.example.com/hook");
    expect(cr.plan).not.toContain("[member] stray");
  });

  it("caller-supplied diffOptions.isOwned overrides the node's `owned` declaration", async () => {
    const applied: string[] = [];
    const live: LiveNodeState = {
      members: [
        { userId: 1, username: "a", accessLevel: 30 },
        { userId: 9, username: "stray", accessLevel: 30 },
      ],
    };
    const result = await runReconcile({
      config: { nodes: { "acme/platform": { kind: "group", owned: true, members: [{ user: "a", accessLevel: 30 }] } } },
      client: mockClient(),
      cycles: [membersCycle(live, applied)],
      mode: "dry-run",
      diffOptions: { isOwned: () => false },
    });
    expect(result.cycles[0]!.counts.delete).toBe(0);
  });

  it("removalDeltaCap blocks a mass-delete apply", async () => {
    const applied: string[] = [];
    const live: LiveNodeState = {
      members: Array.from({ length: 10 }, (_, i) => ({ userId: i, username: `m${i}`, accessLevel: 30 })),
    };
    const result = await runReconcile({
      config: cfg(["m0"]), // keep 1, would delete 9 of 10 live → 90% > 25%
      client: mockClient(),
      cycles: [membersCycle(live, applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true },
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    expect(cr.guardrails.ok).toBe(false);
    expect(applied).toHaveLength(0);
  });
});

const tenLive = (): LiveNodeState => ({
  members: Array.from({ length: 10 }, (_, i) => ({ userId: i, username: `m${i}`, accessLevel: 30 })),
});

describe("removalDeltaCap wiring (per-type live denominators via managedCounts)", () => {
  it("a converged cycle's single stale delete passes: 1 of 10 live is 10%", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]), // drop only m0
      client: mockClient(),
      cycles: [membersCycle(tenLive(), applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true },
    });
    const cr = result.cycles[0]!;
    // Plan-relative, the cap would see 1 delete / 1 managed entry = 100% and
    // block; the live per-type denominator keeps this applyable.
    expect(cr.guardrails.ok).toBe(true);
    expect(cr.guardrailBlocked).toBe(false);
    expect(applied).toEqual(["m0"]);
  });

  it("wiping 3 of 4 webhooks blocks at 75% even with 20 members live (no pooled dilution)", async () => {
    // A pooled denominator would read 3 deletes / 24 live entries = 12.5% and
    // wave the wipe through; per-type counts judge webhooks against webhooks.
    const live: LiveNodeState = {
      members: Array.from({ length: 20 }, (_, i) => ({ userId: i, username: `m${i}`, accessLevel: 30 })),
      webhooks: Array.from({ length: 4 }, (_, i) => ({ id: i, url: `https://h${i}.example.com` })),
    };
    const twoSliceCycle: Cycle = {
      name: "two-slice",
      async fetchLive() {
        return live;
      },
      buildDesired(config: NodeConfig) {
        return { kind: config.kind, members: config.members, webhooks: config.webhooks };
      },
      async apply() {},
    };
    const result = await runReconcile({
      config: {
        nodes: {
          "acme/platform": {
            kind: "group",
            owned: true,
            members: Array.from({ length: 20 }, (_, i) => ({ user: `m${i}`, accessLevel: 30 })),
            webhooks: [{ url: "https://h0.example.com" }], // drops h1..h3
          },
        },
      },
      client: mockClient(),
      cycles: [twoSliceCycle],
      mode: "apply",
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    expect(cr.guardrails.ok).toBe(false);
    if (!cr.guardrails.ok) {
      expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalDeltaCap");
      expect(cr.guardrails.diagnostics[0]!.message).toContain("3 of 4 live webhook entries");
    }
  });

  it("4 deletes of 10 live members blocks (40% > 25%), naming the type", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["m0", "m1", "m2", "m3", "m4", "m5"]), // drop m6..m9
      client: mockClient(),
      cycles: [membersCycle(tenLive(), applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true },
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    expect(cr.guardrails.ok).toBe(false);
    if (!cr.guardrails.ok) {
      expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalDeltaCap");
      expect(cr.guardrails.diagnostics[0]!.message).toContain("4 of 10 live member entries");
    }
    expect(applied).toHaveLength(0);
  });

  it("a zero live count from diff() is no denominator — that type stays plan-relative", () => {
    // A declared slice with nothing live stamps 0, which chant treats as "no
    // live info", never a divide-by-zero or a looser cap.
    const cs = diff("group:acme", { kind: "group", members: [] }, { members: [] });
    expect(cs.managedCounts).toEqual({ member: 0 });
    const diag = removalDeltaCap(
      {
        ...cs,
        entries: [
          { kind: "update", resourceType: "member", key: "a", fields: [] },
          { kind: "delete", resourceType: "member", key: "b" },
        ],
      },
      { maxFraction: 0.25 },
    );
    expect(diag).not.toBeNull();
    expect(diag!.guardrail).toBe("removalDeltaCap");
    expect(diag!.message).toContain("planned member entries");
    expect(diag!.message).not.toContain("live member entries");
  });
});

describe("tier-gated plan NOTEs", () => {
  it("appends a NOTE line for a gated slice to that cycle's plan, after the rendered change set", async () => {
    const gatedCycle: Cycle = {
      name: "mr-approvals",
      async fetchLive(_client, scopeId) {
        noteGatedSlice("mr-approvals", scopeId, "approvalRules"); // simulated 403
        return {};
      },
      buildDesired(config: NodeConfig) {
        return { kind: config.kind, approvalRules: config.approvalRules };
      },
      async apply() {},
    };
    const result = await runReconcile({
      config: { nodes: { "acme/api": { kind: "project", approvalRules: [{ name: "sec", approvalsRequired: 2 }] } } },
      client: mockClient(),
      cycles: [gatedCycle],
      mode: "dry-run",
    });
    const cr = result.cycles[0]!;
    expect(cr.counts.create).toBe(1); // still an optimistic plan…
    const lines = cr.plan.split("\n");
    expect(lines[lines.length - 1]).toBe(
      "NOTE: approvalRules: read was tier-gated (403); planned entries may fail on apply",
    );
    expect(lines[0]).toContain("Plan for"); // rendered change set precedes the note
  });

  it("notes do not leak into other cycles or later runs", async () => {
    const quietCycle: Cycle = {
      name: "quiet",
      async fetchLive() {
        return {};
      },
      buildDesired(config: NodeConfig) {
        return { kind: config.kind };
      },
      async apply() {},
    };
    noteGatedSlice("mr-approvals", "project:acme/api", "approvalRules"); // stale, from a "previous" run
    const result = await runReconcile({
      config: { nodes: { "acme/api": { kind: "project" } } },
      client: mockClient(),
      cycles: [quietCycle],
      mode: "dry-run",
    });
    expect(result.cycles[0]!.plan).not.toContain("NOTE:");
  });
});
