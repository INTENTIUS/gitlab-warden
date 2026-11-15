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
import { decodeDriftLine, type DriftLine, type DriftRecordLine } from "@intentius/chant/drift-record";
import { checkDriftReaderOutput, type DriftReaderInput, type DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import { membersCycle } from "../cycles/members.js";
import { protectedBranchesCycle } from "../cycles/protected-branches.js";
import { ciVariablesCycle } from "../cycles/ci-variables.js";
import { groupSettingsCycle } from "../cycles/group-settings.js";
import { makeClient, type MockClient } from "../cycles/_testutil.js";
import { readGovernance } from "../graph/reader.js";
import { driftAddress, readGovernanceDrift, type ReadGovernanceDriftDeps } from "./reader.js";
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
  config: { dir: d, file: "governance.yml", tokenEnv: "GITLAB_TOKEN", baseUrlEnv: "GITLAB_BASE_URL" },
  member: "governance",
  observedAt: AT,
  ...extra,
});
const deps = (client: MockClient, extra: ReadGovernanceDriftDeps = {}): ReadGovernanceDriftDeps => ({ env: { GITLAB_TOKEN: "t0ken" }, createClient: () => client, cycles, ...extra });

describe("readGovernanceDrift", () => {
  it("reports no drift, start and settle with zero counts, when GitLab matches the policy", async () => {
    const out = await readGovernanceDrift(input(member()), deps(matching()));
    expectValid(out);
    const ls = lines(out);
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({ type: "drift-start", member: "governance", engine: "warden", read: "plan", at: AT, expected: [] });
    expect(ls[1]).toMatchObject({ type: "drift-settle", counts: { drifted: 0, pending: 0, undeclared: 0, "not-observed": 0 } });
  });

  it("gives one record per planned change, addressed by the graph's node ids where it draws one", async () => {
    const out = await readGovernanceDrift(input(member()), deps(drifted()));
    expectValid(out);
    const r = byAddress(out);
    expect(Object.keys(r).sort()).toEqual([
      "member/acme/platform/alice",
      "member/acme/platform/bob",
      "member/acme/platform/carol",
      "protection/acme/platform/api/main",
      "team/acme/platform",
      "variable/acme/platform/api/DEPLOY_KEY@*",
    ]);
    expect(r["team/acme/platform"]).toMatchObject({
      status: "drifted",
      node: null,
      resourceType: "group-settings",
      attributes: [{ path: "visibility", before: "private", after: "public" }],
      evidence: { tool: "gitlab-warden", command: "reconcile --mode dry-run", engineCode: "update" },
    });
    expect(r["member/acme/platform/alice"]).toMatchObject({ status: "drifted", attributes: [{ path: "accessLevel", before: 40, after: 30 }] });
    expect(r["member/acme/platform/carol"]).toMatchObject({ status: "pending", evidence: { engineCode: "create" } });
    expect(r["member/acme/platform/carol"]).not.toHaveProperty("attributes");
    expect(r["member/acme/platform/bob"]).toMatchObject({ status: "undeclared", evidence: { engineCode: "delete" } });
    expect(r["protection/acme/platform/api/main"]).toMatchObject({ status: "drifted", attributes: [{ path: "pushAccessLevel", before: 40, after: 30 }] });
    // A variable's value is never carried.
    expect(r["variable/acme/platform/api/DEPLOY_KEY@*"]).toMatchObject({ status: "drifted", attributes: [{ path: "value", sensitive: true }] });
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(lines(out).at(-1)).toMatchObject({ type: "drift-settle", counts: { drifted: 4, pending: 1, undeclared: 1 } });
  });

  it("reads with GET only: a drift read never writes", async () => {
    const client = drifted();
    await readGovernanceDrift(input(member()), deps(client));
    expect(client.calls.length).toBeGreaterThan(0);
    expect(client.calls.filter((c) => c.method !== "GET" && c.method !== "PAGINATE" && c.method !== "GRAPHQL")).toEqual([]);
  });

  it("gives a cycle that errored a not-observed record, so the read never settles clean", async () => {
    const client = matching();
    const inner = client.paginate.bind(client);
    client.paginate = async <T,>(path: string): Promise<T[]> => {
      if (path.includes("protected_branches")) throw new Error("GET protected_branches returned 500");
      return inner<T>(path);
    };
    const out = await readGovernanceDrift(input(member()), deps(client));
    expectValid(out);
    expect(records(out)).toEqual([
      expect.objectContaining({
        address: "cycle/acme/platform/api/protected-branches",
        status: "not-observed",
        unobserved: { reason: "read-failed", detail: "fetchLive: GET protected_branches returned 500" },
      }),
    ]);
  });

  it("gives a cycle the request budget deferred a not-observed record", async () => {
    const out = await readGovernanceDrift(input(member()), deps(matching(), { requestBudget: 1 }));
    expectValid(out);
    const deferred = records(out).filter((r) => r.unobserved?.reason === "not-reached");
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred[0].address).toMatch(/^cycle\/[a-z-]+@(group|project):/);
  });

  it("places group settings, protected branches and integrations on the graph reader's nodes", () => {
    const graph = new Set(
      readGovernance(
        parse(`
nodes:
  acme/platform: { kind: group, integrations: [{ name: slack }] }
  acme/platform/api: { kind: project, protectedBranches: [{ name: main }] }
`),
      ).nodes.map((n) => n.id),
    );
    for (const [path, resourceType, key] of [
      ["acme/platform", "group-settings", "group-settings"],
      ["acme/platform", "integration", "slack"],
      ["acme/platform/api", "project-settings", "project-settings"],
      ["acme/platform/api", "protected-branch", "main"],
    ]) {
      expect(graph.has(driftAddress(path, { resourceType, key }))).toBe(true);
    }
    expect(driftAddress("acme/platform", { resourceType: "push-rules", key: "push-rules" })).toBe("push-rules/acme/platform");
    expect(driftAddress("acme/new-name", { resourceType: "node", key: "acme/new-name" })).toBe("node/acme/new-name");
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

  it("takes the instance from GITLAB_BASE_URL, else gitlab.com", async () => {
    const seen: string[] = [];
    const d = member();
    const capture = (env: NodeJS.ProcessEnv): ReadGovernanceDriftDeps => ({
      env,
      cycles,
      createClient: (o) => {
        seen.push(o.baseUrl);
        return matching();
      },
    });
    await readGovernanceDrift(input(d), capture({ GITLAB_TOKEN: "t" }));
    await readGovernanceDrift(input(d), capture({ GITLAB_TOKEN: "t", GITLAB_BASE_URL: "https://gitlab.example.com" }));
    expect(seen).toEqual(["https://gitlab.com", "https://gitlab.example.com"]);
  });

  it("refuses --read other than plan and --stack with read-unsupported, and --resource with resource-unsupported", async () => {
    const d = member();
    const cases: Array<[Partial<DriftReaderInput>, string]> = [
      [{ read: "live-read" }, "read-unsupported"],
      [{ stack: "prod" }, "read-unsupported"],
      [{ resource: "team/acme/platform" }, "resource-unsupported"],
    ];
    for (const [extra, code] of cases) {
      const out = await readGovernanceDrift(input(d, extra), deps(matching()));
      expectValid(out);
      expect(out).toMatchObject({ refused: { code } });
    }
  });

  it("throws for a member with no policy, which chant reports as a failed read", async () => {
    dir = mkdtempSync(join(tmpdir(), "gitlab-warden-drift-"));
    await expect(readGovernanceDrift(input(dir), deps(matching()))).rejects.toThrow(/no governance policy/);
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
