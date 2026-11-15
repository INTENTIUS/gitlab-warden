/**
 * The forge-governance drift reader (INTENTIUS/gitlab-warden#74): what it
 * returns passes chant's drift-reader schema and chant's own check
 * (`checkDriftReaderOutput`, which runs every line through `decodeDriftLine`),
 * reports drift for a policy GitLab does not match and none for one it does,
 * and never writes. The GitLab client is mocked the way the cycle tests do it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { decodeDriftLine, type DriftLine, type DriftRecordLine, type ReadDriftResult } from "@intentius/chant/drift-record";
import { checkDriftReaderOutput, type DriftReaderInput } from "@intentius/chant/workspace/drift-reader";
import { membersCycle } from "../cycles/members.js";
import { protectedBranchesCycle } from "../cycles/protected-branches.js";
import { ciVariablesCycle } from "../cycles/ci-variables.js";
import { makeClient, type MockClient } from "../cycles/_testutil.js";
import { readGovernance } from "../graph/reader.js";
import type { GovernanceConfig } from "../config/types.js";
import { driftTargets, readGovernanceDrift } from "./reader.js";
import { readMemberDrift } from "./entry.js";

const require = createRequire(import.meta.url);
const schemaDir = dirname(require.resolve("@intentius/chant/workspace/drift-reader.schema.json"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, "drift.schema.json"), "utf-8")));
const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, "drift-reader.schema.json"), "utf-8")));

const AT = "2026-11-14T12:00:00.000Z";

/** chant's checks, all of them: the schema, then its own reader check, then each line through the codec. */
function expectValid(out: ReadDriftResult): void {
  const wire = JSON.parse(JSON.stringify(out));
  expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
  expect(checkDriftReaderOutput(wire)).not.toHaveProperty("error");
  if ("lines" in wire) for (const l of wire.lines) expect(() => decodeDriftLine(JSON.stringify(l))).not.toThrow();
}

const lines = (out: ReadDriftResult): DriftLine[] => {
  if (!("lines" in out)) throw new Error(`refused: ${JSON.stringify(out)}`);
  return out.lines;
};
const records = (out: ReadDriftResult) => lines(out).filter((l): l is DriftRecordLine => l.type === "drift-record");
const byAddress = (out: ReadDriftResult) => Object.fromEntries(records(out).map((r) => [r.address, r]));

const POLICY = `
nodes:
  acme/platform:
    kind: group
    owned: true
    members:
      - { user: alice, accessLevel: maintainer }
  acme/platform/api:
    kind: project
    protectedBranches:
      - { name: main, pushAccessLevel: 40 }
    variables:
      - { key: DEPLOY_KEY, value: s3cret }
`;
const config = (): GovernanceConfig => parse(POLICY) as GovernanceConfig;

/** GitLab as the policy declares it. */
const matching = (): MockClient =>
  makeClient(
    {},
    {
      "/groups/acme%2Fplatform/members": [{ id: 1, username: "alice", access_level: 40 }],
      "/projects/acme%2Fplatform%2Fapi/protected_branches": [{ name: "main", push_access_levels: [{ access_level: 40 }] }],
      "/projects/acme%2Fplatform%2Fapi/variables": [{ key: "DEPLOY_KEY", value: "s3cret" }],
    },
  );

/** GitLab drifted: alice is a developer, bob is an undeclared member, main lets developers push, the variable's value changed. */
const drifted = (): MockClient =>
  makeClient(
    {},
    {
      "/groups/acme%2Fplatform/members": [
        { id: 1, username: "alice", access_level: 30 },
        { id: 2, username: "bob", access_level: 30 },
      ],
      "/projects/acme%2Fplatform%2Fapi/protected_branches": [{ name: "main", push_access_levels: [{ access_level: 30 }] }],
      "/projects/acme%2Fplatform%2Fapi/variables": [{ key: "DEPLOY_KEY", value: "other" }],
    },
  );

const cycles = [membersCycle, protectedBranchesCycle, ciVariablesCycle];

const read = (client: MockClient, extra: Partial<Parameters<typeof readGovernanceDrift>[0]> = {}) =>
  readGovernanceDrift({ config: config(), client, cycles, member: "governance", observedAt: AT, version: "0.0.0-test", ...extra });

describe("readGovernanceDrift", () => {
  it("reports every declared address in sync when GitLab matches the policy", async () => {
    const out = await read(matching());
    expectValid(out);
    const ls = lines(out);
    expect(ls[0]).toMatchObject({ type: "drift-start", member: "governance", engine: "warden", read: "live-read", at: AT });
    expect(ls.at(-1)).toMatchObject({ type: "drift-settle", counts: { "in-sync": 3, drifted: 0 }, notReached: [] });
    expect(records(out).map((r) => [r.address, r.status])).toEqual([
      ["protection/acme/platform/api/main", "in-sync"],
      ["repo/acme/platform/api", "in-sync"],
      ["team/acme/platform", "in-sync"],
    ]);
  });

  it("puts each planned change on its node as an attribute, declared value before and live value after", async () => {
    const out = await read(drifted());
    expectValid(out);
    const r = byAddress(out);
    expect(r["team/acme/platform"]).toMatchObject({
      status: "drifted",
      node: "team/acme/platform",
      resourceType: "group",
      evidence: { tool: "gitlab-warden", version: "0.0.0-test", command: "reconcile --mode dry-run" },
    });
    expect(r["team/acme/platform"].attributes).toEqual([
      { path: "member[#alice].accessLevel", before: 40, after: 30 },
      { path: "member[#bob]", after: { username: "bob", userId: 2, accessLevel: 30 } },
    ]);
    // The protected branch the policy declares is its own node.
    expect(r["protection/acme/platform/api/main"]).toMatchObject({ status: "drifted", attributes: [{ path: "protected-branch[#main].pushAccessLevel", before: 40, after: 30 }] });
    // A variable's value is never carried.
    expect(r["repo/acme/platform/api"]).toMatchObject({ status: "drifted", attributes: [{ path: "variable[#DEPLOY_KEY@*].value", sensitive: true }] });
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(lines(out).at(-1)).toMatchObject({ type: "drift-settle", counts: { drifted: 3 } });
  });

  it("reads with GET only: a drift read never writes", async () => {
    const client = drifted();
    await read(client);
    expect(client.calls.length).toBeGreaterThan(0);
    expect(client.calls.filter((c) => c.method !== "GET" && c.method !== "PAGINATE" && c.method !== "GRAPHQL")).toEqual([]);
  });

  it("gives an address whose cycle errored as not-observed, never in sync", async () => {
    const client = matching();
    client.paginate = async (path: string) => {
      if (path.includes("protected_branches")) throw new Error("GET protected_branches returned 500");
      return makeClient({}, { "/groups/acme%2Fplatform/members": [{ id: 1, username: "alice", access_level: 40 }], "/projects/acme%2Fplatform%2Fapi/variables": [{ key: "DEPLOY_KEY", value: "s3cret" }] }).paginate(path);
    };
    const out = await read(client);
    expectValid(out);
    const r = byAddress(out);
    expect(r["team/acme/platform"].status).toBe("in-sync");
    for (const a of ["repo/acme/platform/api", "protection/acme/platform/api/main"]) {
      expect(r[a]).toMatchObject({ status: "not-observed", unobserved: { reason: "read-failed" } });
      expect(r[a].unobserved?.detail).toContain("protected-branches errored in fetchLive");
    }
  });

  it("keeps drift it found on a node where another cycle failed, marking the attributes unobserved", async () => {
    const client = drifted();
    const inner = client.paginate.bind(client);
    client.paginate = async (path: string) => {
      if (path.includes("protected_branches")) throw new Error("boom");
      return inner(path);
    };
    const out = await read(client);
    expectValid(out);
    expect(byAddress(out)["repo/acme/platform/api"]).toMatchObject({ status: "drifted", attributesUnobserved: { reason: "read-failed" } });
  });

  it("marks every address not reached when the request budget skips a cycle", async () => {
    const out = await read(matching(), { requestBudget: 1 });
    expectValid(out);
    const statuses = records(out).map((r) => r.status);
    expect(statuses).toContain("not-observed");
    expect(statuses).not.toContain("in-sync");
  });

  it("reads one address with --resource, and refuses one the policy does not declare", async () => {
    const client = drifted();
    const out = await read(client, { resource: "protection/acme/platform/api/main" });
    expectValid(out);
    expect(lines(out)[0]).toMatchObject({ type: "drift-start", resource: "protection/acme/platform/api/main", expected: [{ address: "protection/acme/platform/api/main" }] });
    expect(records(out).map((r) => r.address)).toEqual(["protection/acme/platform/api/main"]);
    expect(client.calls.some((c) => c.path.includes("/groups/"))).toBe(false);

    const refused = await read(drifted(), { resource: "repo/acme/nope" });
    expectValid(refused);
    expect(refused).toMatchObject({ refused: { code: "no-drift-read" } });
  });

  it("names the nodes the graph reader draws, so chant places each record on the graph", () => {
    const doc = parse(`
nodes:
  acme/platform: { kind: group, integrations: [{ name: slack }] }
  acme/platform/api: { kind: project, protectedBranches: [{ name: main }], integrations: [{ name: jira }] }
  gitlab.example.com: { kind: instance }
`);
    const graphIds = readGovernance(doc).nodes.map((n) => n.id).filter((id) => !id.startsWith("org/"));
    const targets = driftTargets(doc as GovernanceConfig);
    expect(targets.filter((t) => t.node !== null).map((t) => t.address).sort()).toEqual(graphIds.sort());
    expect(targets.find((t) => t.address === "instance/gitlab.example.com")).toMatchObject({ node: null });
  });
});

describe("the drift reader module", () => {
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
  const input = (d: string, extra: Partial<DriftReaderInput> = {}): DriftReaderInput => ({ dir: d, config: { dir: d, file: "governance.yml" }, member: "forge", observedAt: AT, ...extra });

  it("reads the member's policy with the token from GITLAB_TOKEN", async () => {
    const d = member();
    let seen: { baseUrl: string; token: string } | undefined;
    const out = await readMemberDrift(input(d), {
      env: { GITLAB_TOKEN: "t0ken" },
      client: (o) => {
        seen = o;
        return matching();
      },
    });
    expectValid(out);
    expect(seen).toEqual({ baseUrl: "https://gitlab.com", token: "t0ken" });
    expect(lines(out)[0]).toMatchObject({ member: "forge" });
  });

  it("takes the instance from GITLAB_BASE_URL", async () => {
    const d = member();
    let seen: { baseUrl: string } | undefined;
    await readMemberDrift(input(d), { env: { GITLAB_TOKEN: "t", GITLAB_BASE_URL: "https://gitlab.example.com" }, client: (o) => ((seen = o), matching()) });
    expect(seen?.baseUrl).toBe("https://gitlab.example.com");
  });

  it("refuses with no-drift-read, without throwing, when the token is missing", async () => {
    const d = member();
    const out = await readMemberDrift(input(d), { env: {}, client: () => { throw new Error("no client without a token"); } });
    expectValid(out);
    expect(out).toEqual({ refused: { code: "no-drift-read", message: "GITLAB_TOKEN is not set, so gitlab-warden cannot read GitLab for forge" } });
  });

  it("refuses with no-drift-read when the member has no policy", async () => {
    dir = mkdtempSync(join(tmpdir(), "gitlab-warden-drift-"));
    const out = await readMemberDrift(input(dir), { env: { GITLAB_TOKEN: "t" } });
    expectValid(out);
    expect(out).toMatchObject({ refused: { code: "no-drift-read" } });
  });

  it("reads a member that still has governance.yaml, with a deprecation note", async () => {
    const d = member("governance.yaml");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = await readMemberDrift(input(d), { env: { GITLAB_TOKEN: "t" }, client: () => matching() });
    expectValid(out);
    expect(String(err.mock.calls[0]?.[0])).toContain("governance.yaml is deprecated");
  });

  it("refuses a read other than live-read and a --stack with read-unsupported", async () => {
    const d = member();
    for (const extra of [{ read: "state" as const }, { stack: "prod" }]) {
      const out = await readMemberDrift(input(d, extra), { env: { GITLAB_TOKEN: "t" }, client: () => matching() });
      expectValid(out);
      expect(out).toMatchObject({ refused: { code: "read-unsupported" } });
    }
  });
});
