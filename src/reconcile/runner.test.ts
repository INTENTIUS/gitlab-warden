/**
 * Runner integration — warden's runReconcile (chant harness + GitLab diff +
 * guardrails) driven with a fake cycle and a mock client, plus the scope-id
 * helpers.
 */

import { describe, it, expect } from "vitest";
import { runReconcile, parseScope, nodeScopeId, type Cycle } from "./runner.js";
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

  it("removalDeltaCap blocks a mass-delete apply (guardrail reused from chant)", async () => {
    const applied: string[] = [];
    const live: LiveNodeState = {
      members: Array.from({ length: 10 }, (_, i) => ({ userId: i, username: `m${i}`, accessLevel: 30 })),
    };
    const result = await runReconcile({
      config: cfg(["m0"]), // keep 1, would delete 9 of 10 → 90% > 25%
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
