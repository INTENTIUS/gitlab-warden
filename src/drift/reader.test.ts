/**
 * The forge-governance drift reader (INTENTIUS/gitlab-warden#74): what it
 * returns passes chant's drift-reader schema and chant's own check
 * (`checkDriftReaderOutput`, which runs every line through `decodeDriftLine`),
 * gives one record per declared node (in-sync or drifted, each planned change
 * an attribute) and never writes. The GitLab client is mocked the way the cycle tests do it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { decodeDriftLine, type DriftLine, type DriftRecordLine } from "@intentius/chant/drift-record";
import { checkDriftReaderOutput, type DriftReaderInput, type DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import { membersCycle } from "../cycles/members.js";
import { protectedBranchesCycle } from "../cycles/protected-branches.js";
import { ciVariablesCycle } from "../cycles/ci-variables.js";
import { groupSettingsCycle } from "../cycles/group-settings.js";
import { makeClient, type MockClient } from "../cycles/_testutil.js";
import { readGovernance } from "../graph/reader.js";
import { declaredNodes, driftAddress, driftAttributes, governanceDrift, readGovernanceDrift, type ReadGovernanceDriftDeps } from "./reader.js";
import type { GovernanceConfig } from "../config/types.js";
import read from "./entry.js";

const require = createRequire(import.meta.url);
const schemaDir = dirname(require.resolve("@intentius/chant/workspace/drift-reader.schema.json"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, "drift.schema.json"), "utf-8")));
const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, "drift-reader.schema.json"), "utf-8")));

const AT = "2026-11-14T12:00:00.000Z";

/** chant's checks, all of them: the schema, then its own reader check, then each line through the codec. */
function expectValid(out: DriftReaderOutput): void {
  const wire = JSON.parse(JSON.stringify(out));
  expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
  expect(checkDriftReaderOutput(wire)).not.toHaveProperty("error");
  if ("lines" in wire) for (const l of wire.lines) expect(() => decodeDriftLine(JSON.stringify(l))).not.toThrow();
}

const lines = (out: DriftReaderOutput): DriftLine[] => {
  if (!("lines" in out)) throw new Error(`refused: ${JSON.stringify(out)}`);
  return out.lines;
};
const records = (out: DriftReaderOutput) => lines(out).filter((l): l is DriftRecordLine => l.type === "drift-record");
const byAddress = (out: DriftReaderOutput) => Object.fromEntries(records(out).map((r) => [r.address, r]));

const POLICY = `
nodes:
  acme/platform:
    kind: group
    owned: true
    groupSettings: { visibility: private }
    members:
      - { user: alice, accessLevel: maintainer }
      - { user: carol, accessLevel: developer }
  acme/platform/api:
    kind: project
    protectedBranches:
      - { name: main, pushAccessLevel: 40 }
    variables:
      - { key: DEPLOY_KEY, value: s3cret }
`;

/** GitLab as the policy declares it. */
const matching = (): MockClient =>
  makeClient(
    { "GET /groups/acme%2Fplatform": { visibility: "private" } },
    {
      "/groups/acme%2Fplatform/members": [
        { id: 1, username: "alice", access_level: 40 },
        { id: 3, username: "carol", access_level: 30 },
      ],
      "/projects/acme%2Fplatform%2Fapi/protected_branches": [{ name: "main", push_access_levels: [{ access_level: 40 }] }],
      "/projects/acme%2Fplatform%2Fapi/variables": [{ key: "DEPLOY_KEY", value: "s3cret" }],
    },
  );

/** GitLab drifted: the group is public, alice is a developer, carol is missing, bob is undeclared, main lets developers push, the variable's value changed. */
const drifted = (): MockClient =>
  makeClient(
    { "GET /groups/acme%2Fplatform": { visibility: "public" } },
    {
      "/groups/acme%2Fplatform/members": [
        { id: 1, username: "alice", access_level: 30 },
        { id: 2, username: "bob", access_level: 30 },
      ],
      "/projects/acme%2Fplatform%2Fapi/protected_branches": [{ name: "main", push_access_levels: [{ access_level: 30 }] }],
      "/projects/acme%2Fplatform%2Fapi/variables": [{ key: "DEPLOY_KEY", value: "other" }],
    },
  );

const cycles = [groupSettingsCycle, membersCycle, protectedBranchesCycle, ciVariablesCycle];

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});
const member = (file = "governance.yml", text = POLICY): string => {
  dir = mkdtempSync(join(tmpdir(), "gitlab-warden-drift-"));
  writeFileSync(join(dir, file), text);
  return dir;
};
const input = (d: string, extra: Partial<DriftReaderInput> = {}): DriftReaderInput => ({
  dir: d,
  config: { dir: d, file: "governance.yml" },
  member: "governance",
  observedAt: AT,
  ...extra,
});
const deps = (client: MockClient, extra: ReadGovernanceDriftDeps = {}): ReadGovernanceDriftDeps => ({ env: { GITLAB_TOKEN: "t0ken" }, createClient: () => client, cycles, ...extra });

const NODES = ["team/acme/platform", "repo/acme/platform/api", "protection/acme/platform/api/main"];
/** The same nodes in the order the settled stream lists records: by address. */
const SETTLED = [...NODES].sort();

describe("driftAttributes", () => {
  it("an update gives one attribute per field, declared before and live after", () => {
    expect(driftAttributes({ kind: "update", resourceType: "member", key: "alice", fields: [{ field: "accessLevel", before: 30, after: 40 }] })).toEqual([
      { path: "member[#alice].accessLevel", before: 40, after: 30 },
    ]);
    expect(driftAttributes({ kind: "update", resourceType: "group-settings", key: "group-settings", fields: [{ field: "visibility", before: "public", after: "private" }] })).toEqual([
      { path: "group-settings.visibility", before: "private", after: "public" },
    ]);
  });

  it("a create carries the declared value, a delete the live one", () => {
    expect(driftAttributes({ kind: "create", resourceType: "member", key: "carol", after: { user: "carol" } })).toEqual([{ path: "member[#carol]", before: { user: "carol" } }]);
    expect(driftAttributes({ kind: "delete", resourceType: "member", key: "bob", before: { user: "bob" } })).toEqual([{ path: "member[#bob]", after: { user: "bob" } }]);
  });

  it("a type whose values can hold a secret carries none", () => {
    expect(driftAttributes({ kind: "update", resourceType: "variable", key: "DEPLOY_KEY@*", fields: [{ field: "value", before: "a", after: "b" }] })).toEqual([
      { path: "variable[#DEPLOY_KEY@*].value", sensitive: true },
    ]);
    expect(driftAttributes({ kind: "create", resourceType: "webhook", key: "https://x", after: { url: "https://x", token: "t" } })).toEqual([{ path: "webhook[#https://x]", sensitive: true }]);
  });
});

describe("declaredNodes and driftAddress", () => {
  const doc = `
nodes:
  acme/platform: { kind: group, integrations: [{ name: slack }] }
  acme/platform/api: { kind: project, protectedBranches: [{ name: release/* }] }
  gitlab.example.com: { kind: instance }
`;
  const policy = parse(doc) as GovernanceConfig;

  it("are the graph reader's node ids, without its namespace nodes, then the instance nodes", () => {
    const graph = readGovernance(policy).nodes.map((n) => n.id);
    expect(declaredNodes(policy)).toEqual([
      { address: "team/acme/platform", path: "acme/platform" },
      { address: "app/acme/platform/slack", path: "acme/platform" },
      { address: "repo/acme/platform/api", path: "acme/platform/api" },
      { address: "protection/acme/platform/api/release/*", path: "acme/platform/api" },
      { address: "instance/gitlab.example.com", path: "gitlab.example.com" },
    ]);
    for (const n of declaredNodes(policy).slice(0, 4)) expect(graph).toContain(n.address);
  });

  it("puts a change on its node, or on the protected branch or integration it names", () => {
    expect(driftAddress("group", "acme/platform", { resourceType: "group-settings", key: "group-settings" })).toBe("team/acme/platform");
    expect(driftAddress("group", "acme/platform", { resourceType: "member", key: "alice" })).toBe("team/acme/platform");
    expect(driftAddress("group", "acme/platform", { resourceType: "integration", key: "slack" })).toBe("app/acme/platform/slack");
    expect(driftAddress("project", "acme/platform/api", { resourceType: "push-rules", key: "push-rules" })).toBe("repo/acme/platform/api");
    expect(driftAddress("project", "acme/platform/api", { resourceType: "protected-branch", key: "main" })).toBe("protection/acme/platform/api/main");
    expect(driftAddress("instance", "gitlab.example.com", { resourceType: "system-hook", key: "https://x" })).toBe("instance/gitlab.example.com");
  });
});

describe("governanceDrift", () => {
  const policy = parse(POLICY) as GovernanceConfig;
  const update = { kind: "update" as const, resourceType: "member", key: "alice", fields: [{ field: "accessLevel", before: 30, after: 40 }] };

  it("names every declared node, in-sync unless a planned change falls under it", () => {
    const { start, records } = governanceDrift({ member: "governance", observedAt: AT, policy, changeSets: [{ org: "group:acme/platform", entries: [update] }] });
    expect(start.expected).toEqual(NODES);
    expect(records.map((r) => [r.address, r.status, r.attributes?.map((a) => a.path)])).toEqual([
      ["team/acme/platform", "drifted", ["member[#alice].accessLevel"]],
      ["repo/acme/platform/api", "in-sync", undefined],
      ["protection/acme/platform/api/main", "in-sync", undefined],
    ]);
  });

  it("a cycle that errored leaves its node's records not-observed, or drifted with attributesUnobserved where others found drift", () => {
    const { records } = governanceDrift({
      member: "governance",
      observedAt: AT,
      policy,
      changeSets: [{ org: "project:acme/platform/api", entries: [{ kind: "update", resourceType: "project-settings", key: "project-settings", fields: [{ field: "visibility", before: "public", after: "private" }] }] }],
      errored: [{ name: "protected-branches", org: "project:acme/platform/api", stage: "fetchLive", error: "GET protected_branches returned 500" }],
    });
    const why = { reason: "read-failed", detail: "protected-branches errored in fetchLive: GET protected_branches returned 500" };
    expect(records.map((r) => [r.address, r.status])).toEqual([
      ["team/acme/platform", "in-sync"],
      ["repo/acme/platform/api", "drifted"],
      ["protection/acme/platform/api/main", "not-observed"],
    ]);
    expect(records[1].attributesUnobserved).toEqual(why);
    expect(records[2].unobserved).toEqual(why);
  });

  it("a deferred cycle leaves every node not-observed", () => {
    const { records } = governanceDrift({ member: "governance", observedAt: AT, policy, changeSets: [], deferred: { skippedCycles: ["members@group:acme/platform"], skippedEntries: [] } });
    expect(new Set(records.map((r) => r.status))).toEqual(new Set(["not-observed"]));
    expect(records[0].unobserved).toEqual({ reason: "not-reached", detail: "deferred by the request budget: members@group:acme/platform" });
  });

  it("a change under a node the graph does not draw is a record of its own", () => {
    const { records } = governanceDrift({
      member: "governance",
      observedAt: AT,
      policy,
      changeSets: [{ org: "project:acme/platform/api", entries: [{ kind: "delete", resourceType: "protected-branch", key: "legacy", before: { name: "legacy" } }] }],
    });
    expect(records.at(-1)).toMatchObject({ address: "protection/acme/platform/api/legacy", status: "drifted", node: null, attributes: [{ path: "protected-branch[#legacy]", after: { name: "legacy" } }] });
  });

  it("puts a pending rename's changes on the node's declared path", () => {
    const renamed = parse(`nodes:\n  acme/new-name: { kind: group, previously: acme/old-name }\n`) as GovernanceConfig;
    const { records } = governanceDrift({
      member: "governance",
      observedAt: AT,
      policy: renamed,
      changeSets: [{ org: "group:acme/old-name", entries: [{ kind: "update", resourceType: "node", key: "acme/new-name", fields: [{ field: "path", before: "acme/old-name", after: "acme/new-name" }] }] }],
    });
    expect(records).toEqual([expect.objectContaining({ address: "team/acme/new-name", status: "drifted", attributes: [{ path: "node[#acme/new-name].path", before: "acme/new-name", after: "acme/old-name" }] })]);
  });
});

describe("readGovernanceDrift", () => {
  it("reports every declared node in-sync when GitLab matches the policy", async () => {
    const out = await readGovernanceDrift(input(member()), deps(matching()));
    expectValid(out);
    const ls = lines(out);
    expect(ls[0]).toMatchObject({ type: "drift-start", member: "governance", engine: "warden", read: "live-read", at: AT, expected: NODES });
    expect(records(out).map((r) => [r.address, r.status])).toEqual(SETTLED.map((a) => [a, "in-sync"]));
    expect(ls.at(-1)).toMatchObject({ type: "drift-settle", counts: { "in-sync": 3, drifted: 0, pending: 0, undeclared: 0, "not-observed": 0 } });
  });

  it("gives each node with planned changes a drifted record, one attribute per change", async () => {
    const out = await readGovernanceDrift(input(member()), deps(drifted()));
    expectValid(out);
    const r = byAddress(out);
    expect(Object.keys(r)).toEqual(SETTLED);
    expect(r["team/acme/platform"]).toMatchObject({
      status: "drifted",
      node: null,
      evidence: { tool: "gitlab-warden", command: "reconcile --mode dry-run" },
    });
    expect(r["team/acme/platform"]).not.toHaveProperty("resourceType");
    expect(r["team/acme/platform"].attributes).toEqual(
      expect.arrayContaining([
        { path: "group-settings.visibility", before: "private", after: "public" },
        { path: "member[#alice].accessLevel", before: 40, after: 30 },
        expect.objectContaining({ path: "member[#carol]", before: expect.anything() }),
        expect.objectContaining({ path: "member[#bob]", after: expect.anything() }),
      ]),
    );
    expect(r["protection/acme/platform/api/main"]).toMatchObject({ status: "drifted", attributes: [{ path: "protected-branch[#main].pushAccessLevel", before: 40, after: 30 }] });
    // A variable's value is never carried.
    expect(r["repo/acme/platform/api"]).toMatchObject({ status: "drifted", attributes: [{ path: "variable[#DEPLOY_KEY@*].value", sensitive: true }] });
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(lines(out).at(-1)).toMatchObject({ type: "drift-settle", counts: { drifted: 3, "in-sync": 0 } });
  });

  it("reads with GET only: a drift read never writes", async () => {
    const client = drifted();
    await readGovernanceDrift(input(member()), deps(client));
    expect(client.calls.length).toBeGreaterThan(0);
    expect(client.calls.filter((c) => c.method !== "GET" && c.method !== "PAGINATE" && c.method !== "GRAPHQL")).toEqual([]);
  });

  it("a cycle that errored leaves its node not-observed, so the read never settles clean", async () => {
    const client = matching();
    const inner = client.paginate.bind(client);
    client.paginate = async <T,>(path: string): Promise<T[]> => {
      if (path.includes("protected_branches")) throw new Error("GET protected_branches returned 500");
      return inner<T>(path);
    };
    const out = await readGovernanceDrift(input(member()), deps(client));
    expectValid(out);
    expect(records(out).map((r) => [r.address, r.status])).toEqual([
      ["protection/acme/platform/api/main", "not-observed"],
      ["repo/acme/platform/api", "not-observed"],
      ["team/acme/platform", "in-sync"],
    ]);
    expect(records(out)[1].unobserved).toEqual({ reason: "read-failed", detail: "protected-branches errored in fetchLive: GET protected_branches returned 500" });
  });

  it("a cycle the request budget deferred leaves every node not-observed", async () => {
    const out = await readGovernanceDrift(input(member()), deps(matching(), { requestBudget: 1 }));
    expectValid(out);
    expect(new Set(records(out).map((r) => r.status))).toEqual(new Set(["not-observed"]));
    expect(records(out)[0].unobserved?.detail).toMatch(/^deferred by the request budget: [a-z-]+@(group|project):/);
  });

  it("reads one declared node alone with --resource, and refuses an undeclared one", async () => {
    const d = member();
    const client = drifted();
    const out = await readGovernanceDrift(input(d, { resource: "repo/acme/platform/api" }), deps(client));
    expectValid(out);
    expect(lines(out)[0]).toMatchObject({ type: "drift-start", resource: "repo/acme/platform/api", expected: ["repo/acme/platform/api"] });
    expect(records(out).map((r) => [r.address, r.status])).toEqual([["repo/acme/platform/api", "drifted"]]);
    // Only the project was reconciled.
    expect(client.calls.some((c) => c.path.startsWith("/groups/"))).toBe(false);
    const refused = await readGovernanceDrift(input(d, { resource: "repo/acme/nope" }), deps(drifted()));
    expectValid(refused);
    expect(refused).toEqual({ refused: { code: "no-drift-read", message: "governance's policy declares no repo/acme/nope" } });
  });

  it("refuses without throwing when the token is missing", async () => {
    const out = await readGovernanceDrift(input(member()), {
      env: {},
      createClient: () => {
        throw new Error("no client without a token");
      },
    });
    expectValid(out);
    expect(out).toEqual({ refused: { code: "no-drift-read", message: "GITLAB_TOKEN is not set; gitlab-warden reads its GitLab API token from it to read governance's drift" } });
  });

  it("takes the instance from GITLAB_BASE_URL, else gitlab.com, and the variables the kind's config names", async () => {
    const seen: Array<{ baseUrl: string; token: string }> = [];
    const d = member();
    const capture = (env: NodeJS.ProcessEnv): ReadGovernanceDriftDeps => ({
      env,
      cycles,
      createClient: (o) => {
        seen.push(o);
        return matching();
      },
    });
    await readGovernanceDrift(input(d), capture({ GITLAB_TOKEN: "t" }));
    await readGovernanceDrift(input(d), capture({ GITLAB_TOKEN: "t", GITLAB_BASE_URL: "https://gitlab.example.com" }));
    await readGovernanceDrift(input(d, { config: { file: "governance.yml", tokenEnv: "MY_TOKEN", baseUrlEnv: "MY_URL" } }), capture({ MY_TOKEN: "abc", MY_URL: "https://git.example.org" }));
    expect(seen).toEqual([
      { baseUrl: "https://gitlab.com", token: "t" },
      { baseUrl: "https://gitlab.example.com", token: "t" },
      { baseUrl: "https://git.example.org", token: "abc" },
    ]);
  });

  it("refuses --read other than live-read and --stack with read-unsupported", async () => {
    const d = member();
    for (const extra of [{ read: "plan" }, { read: "state" }, { stack: "prod" }] as Array<Partial<DriftReaderInput>>) {
      const out = await readGovernanceDrift(input(d, extra), deps(matching()));
      expectValid(out);
      expect(out).toEqual({ refused: { code: "read-unsupported", message: expect.any(String) } });
    }
    expectValid(await readGovernanceDrift(input(d, { read: "live-read" }), deps(matching())));
  });

  it("refuses with no-drift-read for a member with no policy", async () => {
    dir = mkdtempSync(join(tmpdir(), "gitlab-warden-drift-"));
    const out = await readGovernanceDrift(input(dir), deps(matching()));
    expectValid(out);
    expect(out).toEqual({ refused: { code: "no-drift-read", message: expect.stringContaining("has no governance policy") } });
  });

  it("throws for a policy that does not load, which chant reports as a failed read", async () => {
    await expect(readGovernanceDrift(input(member("governance.yml", "nodes: {acme: [unclosed\n")), deps(matching()))).rejects.toThrow();
  });

  it("reads a member that still has governance.yaml, with a deprecation note", async () => {
    const d = member("governance.yaml");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expectValid(await readGovernanceDrift(input(d), deps(matching())));
    expect(String(err.mock.calls[0]?.[0])).toContain("governance.yaml is deprecated");
  });

  it("is the module's default export", async () => {
    const out = await read(input(member(), { stack: "x" }));
    expect(out).toMatchObject({ refused: { code: "read-unsupported" } });
  });
});
