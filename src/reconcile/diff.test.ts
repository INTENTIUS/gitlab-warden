import { describe, it, expect } from "vitest";
import { diff } from "./diff.js";
import type { NodeConfig } from "../config/types.js";
import type { LiveNodeState, LiveMember } from "./live.js";

const node = "group:acme/platform";
function entriesByType(cs: { entries: Array<{ resourceType: string; kind: string; key: string }> }) {
  return cs.entries.map((e) => `${e.kind} ${e.resourceType} ${e.key}`);
}

describe("diff — settings (object slices)", () => {
  it("emits create when the slice is absent live", () => {
    const cs = diff(node, { kind: "group", groupSettings: { description: "x" } }, {});
    expect(entriesByType(cs)).toEqual(["create group-settings group-settings"]);
  });
  it("emits update only for drifted fields (selective-by-omission)", () => {
    const desired: NodeConfig = { kind: "group", groupSettings: { description: "new", visibility: "private" } };
    const live: LiveNodeState = { groupSettings: { description: "old", visibility: "private" } };
    const cs = diff(node, desired, live);
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.fields).toEqual([{ field: "description", before: "old", after: "new" }]);
  });
  it("diffs project topics as a set", () => {
    const cs = diff("project:acme/api", { kind: "project", projectSettings: { topics: ["b", "a"] } }, { projectSettings: { topics: ["a", "b"] } });
    expect(cs.entries).toHaveLength(0);
  });
});

describe("diff — members (direct only; inheritance-safe)", () => {
  const direct: LiveMember[] = [
    { userId: 1, username: "alice", accessLevel: 30 },
    { userId: 2, username: "bob", accessLevel: 40 },
  ];

  it("access-level drift → update; name↔number resolved", () => {
    const cs = diff(node, { kind: "group", members: [{ user: "alice", accessLevel: "maintainer" }, { user: "bob", accessLevel: 40 }] }, { members: direct });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]).toMatchObject({ kind: "update", key: "alice" });
    expect(cs.entries[0]!.fields).toEqual([{ field: "accessLevel", before: 30, after: 40 }]);
  });

  it("ownership-gated delete of a direct member not in config", () => {
    const cs = diff(node, { kind: "group", members: [{ user: "alice", accessLevel: "developer" }] }, { members: direct }, { isOwned: () => true });
    expect(entriesByType(cs)).toContain("delete member bob");
  });

  it("an INHERITED member (absent from the direct roster) is never a delete candidate", () => {
    // live.members is direct-only; an inherited member simply isn't here.
    const cs = diff(node, { kind: "group", members: [{ user: "alice", accessLevel: "developer" }, { user: "bob", accessLevel: "maintainer" }] }, { members: direct }, { isOwned: () => true });
    // carol is inherited from an ancestor → not in direct → no entry of any kind
    expect(cs.entries.some((e) => e.key === "carol")).toBe(false);
    expect(cs.entries).toHaveLength(0);
  });
});

describe("diff — collections", () => {
  it("protected branches keyed by name with field compare", () => {
    const cs = diff("project:acme/api", { kind: "project", protectedBranches: [{ name: "main", pushAccessLevel: 40 }] }, { protectedBranches: [{ name: "main", pushAccessLevel: 30 }] });
    expect(cs.entries[0]).toMatchObject({ kind: "update", resourceType: "protected-branch", key: "main" });
  });
  it("variables keyed by (key, environmentScope)", () => {
    const desired: NodeConfig = { kind: "project", variables: [{ key: "TOKEN", environmentScope: "prod", value: "a" }] };
    const cs = diff("project:acme/api", desired, { variables: [{ key: "TOKEN", environmentScope: "prod", value: "b" }] });
    expect(cs.entries[0]).toMatchObject({ kind: "update", resourceType: "variable", key: "TOKEN@prod" });
  });
  it("webhooks keyed by url; baseline by existence", () => {
    const cs = diff(node, { kind: "group", webhooks: [{ url: "https://h" }], baselines: [{ kind: "project", path: "new" }] }, { webhooks: [], children: ["existing"] });
    expect(entriesByType(cs)).toEqual(expect.arrayContaining(["create webhook https://h", "create baseline new"]));
  });
});

describe("diff — pipeline schedules (keyed by description)", () => {
  const proj = "project:acme/api";
  const nightly = { description: "nightly-build", cron: "0 2 * * *", ref: "main" };

  it("absent live → create; converged → no entries", () => {
    expect(entriesByType(diff(proj, { kind: "project", pipelineSchedules: [nightly] }, {}))).toEqual([
      "create pipeline-schedule nightly-build",
    ]);
    const converged = diff(
      proj,
      { kind: "project", pipelineSchedules: [{ ...nightly, active: true, variables: [{ key: "K", value: "v" }] }] },
      { pipelineSchedules: [{ id: 1, ...nightly, active: true, variables: [{ key: "K", value: "v", variableType: "env_var" }] }] },
    );
    expect(converged.entries).toHaveLength(0);
  });

  it("cron/ref/active drift → update with only the drifted fields", () => {
    const cs = diff(
      proj,
      { kind: "project", pipelineSchedules: [{ ...nightly, active: false }] },
      { pipelineSchedules: [{ id: 1, description: "nightly-build", cron: "0 3 * * *", ref: "main", active: true }] },
    );
    expect(cs.entries[0]).toMatchObject({ kind: "update", resourceType: "pipeline-schedule", key: "nightly-build" });
    expect(cs.entries[0]!.fields!.map((f) => f.field).sort()).toEqual(["active", "cron"]);
  });

  it("variables drift by key → a single `variables` field change; unowned live extras ride along", () => {
    const live: LiveNodeState = {
      pipelineSchedules: [{ id: 1, ...nightly, variables: [{ key: "K", value: "old" }, { key: "STALE", value: "x" }] }],
    };
    const cs = diff(proj, { kind: "project", pipelineSchedules: [{ ...nightly, variables: [{ key: "K", value: "new" }] }] }, live);
    // Not owned: the drifted K is corrected, and the undeclared STALE is
    // carried over in the target list so the apply path won't delete it.
    expect(cs.entries[0]!.fields).toEqual([
      {
        field: "variables",
        before: live.pipelineSchedules![0]!.variables,
        after: [{ key: "K", value: "new" }, { key: "STALE", value: "x" }],
      },
    ]);
    expect((cs.entries[0]!.after as { variables?: unknown }).variables).toEqual([
      { key: "K", value: "new" },
      { key: "STALE", value: "x" },
    ]);
    // No `variables` declared → the live variables are not managed.
    expect(diff(proj, { kind: "project", pipelineSchedules: [nightly] }, live).entries).toHaveLength(0);
  });

  it("a live-extra variable is drift only when the schedule is owned (no perpetual unowned plan)", () => {
    const live: LiveNodeState = {
      pipelineSchedules: [{ id: 1, ...nightly, variables: [{ key: "K", value: "v" }, { key: "STALE", value: "x" }] }],
    };
    const declared = { kind: "project" as const, pipelineSchedules: [{ ...nightly, variables: [{ key: "K", value: "v" }] }] };
    // Not owned: the extra live variable is left alone — converged, no plan.
    expect(diff(proj, declared, live).entries).toHaveLength(0);
    // Owned: the deletion is visible in the plan as a variables update whose
    // target list omits the extra.
    const owned = diff(proj, declared, live, { isOwned: (t) => t === "pipeline-schedule" });
    expect(owned.entries).toHaveLength(1);
    expect(owned.entries[0]!.fields).toEqual([
      { field: "variables", before: live.pipelineSchedules![0]!.variables, after: [{ key: "K", value: "v" }] },
    ]);
  });

  it("renaming a description is a delete + create (ownership-gated)", () => {
    const live: LiveNodeState = { pipelineSchedules: [{ id: 1, description: "nightly", cron: "0 2 * * *", ref: "main" }] };
    const cs = diff(proj, { kind: "project", pipelineSchedules: [nightly] }, live, { isOwned: () => true });
    expect(entriesByType(cs).sort()).toEqual(["create pipeline-schedule nightly-build", "delete pipeline-schedule nightly"]);
    // Without ownership, the old schedule is left alone.
    const gated = diff(proj, { kind: "project", pipelineSchedules: [nightly] }, live);
    expect(entriesByType(gated)).toEqual(["create pipeline-schedule nightly-build"]);
  });

  it("live schedules count into the removal-cap denominator when the slice is declared", () => {
    const live: LiveNodeState = {
      pipelineSchedules: [
        { id: 1, description: "a", cron: "0 1 * * *", ref: "main" },
        { id: 2, description: "b", cron: "0 2 * * *", ref: "main" },
      ],
    };
    expect(diff(proj, { kind: "project", pipelineSchedules: [] }, live).managedCounts).toEqual({
      "pipeline-schedule": 2,
    });
    // Undeclared → the type is absent from managedCounts entirely.
    expect(diff(proj, { kind: "project" }, live).managedCounts).toEqual({});
  });
});

describe("diff — ChangeSet shape", () => {
  it("carries the node id and stable ordering", () => {
    const cs = diff(node, { kind: "group", members: [{ user: "z", accessLevel: 30 }], groupSettings: { description: "d" } }, {});
    expect(cs.org).toBe(node);
    // group-settings sorts before member
    expect(cs.entries[0]!.resourceType).toBe("group-settings");
  });

  it("managedCounts holds per-type live counts for declared, delete-capable slices only", () => {
    const desired: NodeConfig = {
      kind: "group",
      groupSettings: { description: "d" }, // single-object slice — never deletes
      baselines: [{ kind: "project", path: "api" }], // create-only — never deletes
      members: [{ user: "alice", accessLevel: 30 }],
      webhooks: [],
      // variables NOT declared → must not appear even though live has some
    };
    const live: LiveNodeState = {
      groupSettings: { description: "d" },
      members: [
        { userId: 1, username: "alice", accessLevel: 30 },
        { userId: 2, username: "bob", accessLevel: 30 },
      ],
      webhooks: [{ id: 1, url: "https://h" }],
      variables: [{ key: "K", value: "v" }],
      children: [],
    };
    expect(diff(node, desired, live).managedCounts).toEqual({ member: 2, webhook: 1 });
  });

  it("a webhook being renamed in place still counts into its type's live denominator", () => {
    const desired: NodeConfig = {
      kind: "group",
      webhooks: [{ url: "https://new", previously: "https://old" }, { url: "https://kept" }],
    };
    const live: LiveNodeState = {
      webhooks: [
        { id: 1, url: "https://old" },
        { id: 2, url: "https://kept" },
      ],
    };
    expect(diff(node, desired, live).managedCounts).toEqual({ webhook: 2 });
  });
});
