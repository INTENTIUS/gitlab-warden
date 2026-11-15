/**
 * `reconcile --plan-json`: the part a run writes reads back through chant's
 * `readChangeSetPartFile`, names the member and carries the planned change
 * sets. The GitLab client is mocked the way the cycle tests do it.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { composeChangeSet, readChangeSetPartFile } from "@intentius/chant/change-set";
import { membersCycle } from "../cycles/members.js";
import { makeClient } from "../cycles/_testutil.js";
import { runReconcile, type Cycle } from "./runner.js";
import { defaultMemberName, planPart, PLAN_PART_LEXICON } from "./plan-part.js";
import type { GovernanceConfig } from "../config/types.js";

const config: GovernanceConfig = {
  nodes: {
    "acme/platform": { kind: "group", owned: true, members: [{ user: "alice", accessLevel: "maintainer" }, { user: "carol", accessLevel: "developer" }] },
  },
};

/** Live: alice is a developer and bob a maintainer, so the plan updates alice, creates carol and deletes bob. */
const client = () =>
  makeClient(
    {},
    {
      "/groups/acme%2Fplatform/members": [
        { id: 1, username: "alice", access_level: 30 },
        { id: 2, username: "bob", access_level: 40 },
      ],
    },
  );

/** What the CLI writes: the part as JSON text, parsed back. */
const roundTrip = (part: unknown): unknown => JSON.parse(`${JSON.stringify(part, null, 2)}\n`);

describe("planPart", () => {
  it("writes a part readChangeSetPartFile accepts, naming the member and carrying the plan", async () => {
    const result = await runReconcile({ config, client: client(), cycles: [membersCycle], mode: "dry-run" });
    expect(result.changeSets).toHaveLength(1);

    const written = roundTrip(planPart({ member: "governance", policy: config, changeSets: result.changeSets, errored: result.errored, deferred: result.deferred }));
    const part = readChangeSetPartFile(written, "warden", "governance", PLAN_PART_LEXICON);

    expect(part.member).toMatchObject({ member: "governance", lexicon: "gitlab", planner: "warden", scope: "group:acme/platform", status: "planned", holes: [] });
    expect(part.member.planDigest).toMatch(/\S/);
    const actions = part.entries.map((e) => [e.action, e.address, e.scope, e.lexicon, e.member]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ["update", "team/acme/platform#member[alice]", "group:acme/platform", "gitlab", "governance"],
        ["create", "team/acme/platform#member[carol]", "group:acme/platform", "gitlab", "governance"],
        ["delete", "team/acme/platform#member[bob]", "group:acme/platform", "gitlab", "governance"],
      ]),
    );
    expect(part.entries).toHaveLength(3);

    // It composes into a change-set document beside other members' parts.
    const doc = composeChangeSet([part]);
    expect(doc.summary.byMember.governance).toMatchObject({ create: 1, update: 1, delete: 1 });
  });

  it("is deterministic: the same plan gives the same digest", async () => {
    const a = await runReconcile({ config, client: client(), cycles: [membersCycle], mode: "dry-run" });
    const b = await runReconcile({ config, client: client(), cycles: [membersCycle], mode: "dry-run" });
    expect(planPart({ member: "m", policy: config, changeSets: a.changeSets }).member.planDigest).toBe(
      planPart({ member: "m", policy: config, changeSets: b.changeSets }).member.planDigest,
    );
  });

  it("marks the member failed, with no digest, when a cycle errored", async () => {
    const broken: Cycle = {
      name: "broken",
      async fetchLive() {
        throw new Error("GET returned 500");
      },
      buildDesired: (desired) => desired,
      async apply() {},
    };
    const result = await runReconcile({ config, client: client(), cycles: [membersCycle, broken], mode: "dry-run" });
    expect(result.errored).toHaveLength(1);

    const part = readChangeSetPartFile(
      roundTrip(planPart({ member: "governance", policy: config, changeSets: result.changeSets, errored: result.errored, deferred: result.deferred })),
      "warden",
      "governance",
    );
    expect(part.member.status).toBe("failed");
    expect(part.member.planDigest).toBeNull();
    expect(part.member.error).toMatch(/broken @ group:acme\/platform errored in fetchLive/);
    // What the other cycles planned stays in the part.
    expect(part.entries).toHaveLength(3);
  });

  it("marks the member failed when the budget deferred a cycle", () => {
    const part = planPart({ member: "m", policy: config, changeSets: [], deferred: { skippedCycles: ["members"], skippedEntries: [] } });
    expect(part.member).toMatchObject({ status: "failed", planDigest: null, error: "members was deferred by the request budget" });
  });
});

describe("defaultMemberName", () => {
  it("is the name of the policy file's directory", () => {
    expect(defaultMemberName("members/governance/governance.yml")).toBe("governance");
    expect(defaultMemberName("governance.yml")).toBe(process.cwd().split("/").pop());
    expect(defaultMemberName(join(process.cwd(), "governance.ts"))).toBe(process.cwd().split("/").pop());
  });
  it("is undefined for a policy at the filesystem root", () => {
    expect(defaultMemberName("/governance.yml")).toBeUndefined();
  });
});
