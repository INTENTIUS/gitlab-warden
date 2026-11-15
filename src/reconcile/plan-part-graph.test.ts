/**
 * `reconcile --plan-json` parts on the forge-governance graph
 * (INTENTIUS/chant#5089): the graph reader draws a policy, a part is written
 * from a change set, and chant's own `mapChangeSetToGraph` places each entry.
 * Every entry must land on the node the drift reader's record for the same
 * change lands on.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { composeChangeSet } from "@intentius/chant/change-set";
import { graphNodeFor, mapChangeSetToGraph } from "@intentius/chant/change-set-graph";
import type { ChangeSet, ChangeSetEntry } from "@intentius/chant/reconcile";
import { readGovernance } from "../graph/reader.js";
import { driftAddress, governanceDrift, scopeNode } from "../drift/reader.js";
import { planPart } from "./plan-part.js";
import type { GovernanceConfig } from "../config/types.js";

const MEMBER = "governance";

/** Two groups, each with an `api` project, a protected branch, an integration and an instance. */
const policy = parse(`
nodes:
  acme/a: { kind: group, owned: true, integrations: [{ name: slack }] }
  acme/b: { kind: group, owned: true }
  acme/a/api: { kind: project, owned: true, protectedBranches: [{ name: main }] }
  acme/b/api: { kind: project, owned: true }
  gitlab.example.com: { kind: instance }
`) as GovernanceConfig;

const update = (resourceType: string, key: string): ChangeSetEntry => ({
  kind: "update",
  resourceType,
  key,
  fields: [{ field: "x", before: 1, after: 2 }],
});
const create = (resourceType: string, key: string): ChangeSetEntry => ({ kind: "create", resourceType, key, after: { value: "v" } });

const changeSets: ChangeSet[] = [
  // A group's own settings, and a change under it.
  { org: "group:acme/a", entries: [update("group-settings", "group-settings"), update("member", "alice"), update("integration", "slack")] },
  // The same-named project in two groups, its own settings and a variable in each.
  { org: "project:acme/a/api", entries: [update("project-settings", "project-settings"), create("variable", "TOKEN"), update("protected-branch", "main")] },
  { org: "project:acme/b/api", entries: [update("project-settings", "project-settings"), create("variable", "TOKEN")] },
  // The instance: the drift reader names `instance/<path>`, which the graph does not draw.
  { org: "instance:gitlab.example.com", entries: [update("instance-settings", "instance-settings"), create("system-hook", "https://hooks.example.com")] },
];

describe("a --plan-json part on the graph", () => {
  const graph = readGovernance(policy);
  const ids = graph.nodes.map((n) => n.id);
  const part = planPart({ member: MEMBER, policy, changeSets });
  const doc = mapChangeSetToGraph(composeChangeSet([part]), { member: null, at: null, ids });

  /** The record address the drift reader gives each change, by scope, type and key. */
  const recordAddress = new Map<string, string>();
  for (const cs of changeSets) {
    const { kind, path } = scopeNode(policy, cs.org);
    for (const e of cs.entries) recordAddress.set(`${cs.org}\u0000${e.resourceType}\u0000${e.key}`, driftAddress(kind, path, e));
  }

  it("gives every entry a distinct address, the two api projects included", () => {
    const addresses = part.entries.map((e) => e.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses).toEqual(
      expect.arrayContaining([
        "team/acme/a",
        "team/acme/a#member[alice]",
        "app/acme/a/slack",
        "repo/acme/a/api",
        "repo/acme/a/api#variable[TOKEN]",
        "protection/acme/a/api/main",
        "repo/acme/b/api",
        "repo/acme/b/api#variable[TOKEN]",
        "instance/gitlab.example.com",
        "instance/gitlab.example.com#system-hook[https://hooks.example.com]",
      ]),
    );
  });

  it("places every entry on the node the drift reader's record for that change is on", () => {
    const { records } = governanceDrift({ member: MEMBER, observedAt: "2026-11-15T00:00:00.000Z", policy, changeSets });
    const drifted = new Set(records.filter((r) => r.status === "drifted").map((r) => r.address));
    const graphNodes = { member: null, at: null, ids };

    expect(doc.entries).toHaveLength(changeSets.reduce((n, cs) => n + cs.entries.length, 0));
    for (const e of doc.entries) {
      const address = recordAddress.get(`${e.scope}\u0000${e.type}\u0000${e.name}`);
      expect(address, `${e.address} has a drift record`).toBeDefined();
      expect(drifted).toContain(address);
      // The node chant gives the drift record's address is the entry's node.
      const recordNode = graphNodeFor({ member: MEMBER, planner: "warden", address: address! }, graphNodes).node;
      expect(e.node, e.address).toBe(recordNode);
      if (address!.startsWith("instance/")) {
        // The graph draws no instance node, so neither the record nor the
        // entry has one (INTENTIUS/gitlab-warden#79).
        expect(e.node).toBeNull();
      } else {
        expect(e.node, e.address).toBe(address);
      }
    }
  });
});
