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

describe("diff — ChangeSet shape", () => {
  it("carries the node id and stable ordering", () => {
    const cs = diff(node, { kind: "group", members: [{ user: "z", accessLevel: 30 }], groupSettings: { description: "d" } }, {});
    expect(cs.org).toBe(node);
    // group-settings sorts before member
    expect(cs.entries[0]!.resourceType).toBe("group-settings");
  });
});
