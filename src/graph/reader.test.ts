import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { readGovernance } from "./reader.js";
import read from "./entry.js";

const POLICY = `
nodes:
  acme/platform:
    kind: group
    groupSettings: { visibility: private }
    members: [{ user: alice, accessLevel: owner }]
    integrations: [{ name: slack, active: true }]
  acme/platform/infra:
    kind: group
  acme/platform/infra/api:
    kind: project
    projectSettings: { mergeMethod: ff }
    protectedBranches:
      - { name: main, pushAccessLevel: 40 }
  acme/platform/web:
    kind: project
  other/solo:
    kind: project
  gitlab.example.com:
    kind: instance
`;

const edge = (g: ReturnType<typeof readGovernance>, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe("readGovernance", () => {
  const g = readGovernance(parse(POLICY), "governance.yaml");

  test("nodes for the orgs, groups, projects, protection and integrations; an instance node is left out", () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      "app/acme/platform/slack",
      "org/acme",
      "org/other",
      "protection/acme/platform/infra/api/main",
      "repo/acme/platform/infra/api",
      "repo/acme/platform/web",
      "repo/other/solo",
      "team/acme/platform",
      "team/acme/platform/infra",
    ]);
    expect(Object.keys(g.groups.byStack).sort()).toEqual(["acme", "other"]);
  });

  test("a group reaches the groups and projects below it through the nearest declared group", () => {
    expect(edge(g, "team/acme/platform", "team/acme/platform/infra")?.viaAttr).toBe("namespace");
    expect(edge(g, "team/acme/platform/infra", "repo/acme/platform/infra/api")?.viaAttr).toBe("access:namespace");
    expect(edge(g, "team/acme/platform", "repo/acme/platform/web")).toBeDefined();
    expect(edge(g, "team/acme/platform", "repo/acme/platform/infra/api")).toBeUndefined();
    expect(g.edges.some((e) => e.to === "repo/other/solo")).toBe(false);
  });

  test("protection and integration edges", () => {
    expect(edge(g, "protection/acme/platform/infra/api/main", "repo/acme/platform/infra/api")).toBeDefined();
    expect(edge(g, "app/acme/platform/slack", "team/acme/platform")?.viaAttr).toBe("integration");
  });

  test("every edge ends at a node, and a document with no nodes is empty", () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    expect(readGovernance({}).nodes).toEqual([]);
  });
});

describe("the reader module", () => {
  const dir = mkdtempSync(join(tmpdir(), "glw-graph-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads governance.yaml from the member's directory", () => {
    mkdirSync(join(dir, "m"));
    writeFileSync(join(dir, "m", "governance.yaml"), POLICY);
    expect(read({ dir: join(dir, "m"), config: {} }).nodes).toHaveLength(9);
  });
});
