/**
 * `gitlab-warden repos`: the written list reads back through chant's
 * `--forge-repos` parser, and against an org workspace it gives WSP014 for a
 * repository the declaration lacks and WSP015 for one the forge no longer
 * has. The GitLab client is mocked the way the cycle tests do it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForgeRepos } from "@intentius/chant/workspace/checks/org";
import { runDeclarationChecks } from "@intentius/chant/workspace/checks";
import { makeClient } from "./cycles/_testutil.js";
import { forgeRepoList, listGroupProjects, pickGroup, policyGroups } from "./repos.js";
import { parseReposArgs } from "./cli.js";
import { GitLabApiError } from "./auth/client.js";

const BASE = "https://gitlab.example.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PROJECTS = "/groups/acme/projects?include_subgroups=true&with_shared=false";

const project = (path: string, archived = false) => ({ path_with_namespace: `acme/${path}`, web_url: `${BASE}/acme/${path}`, archived });

/** acme has api, web, an archived legacy project and platform/runner in a subgroup. */
const client = () =>
  makeClient({ "GET /groups/acme": { id: 1, full_path: "acme" } }, { [PROJECTS]: [project("web"), project("legacy", true), project("platform/runner"), project("api")] });

/** What the CLI writes: the document as JSON text. */
const written = async () => `${JSON.stringify(await forgeRepoList(client(), "acme", BASE), null, 2)}\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An org workspace whose repo members name these URLs. */
function orgWorkspace(urls: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "glw-repos-"));
  roots.push(root);
  const members = Object.entries(urls).map(([name, url]) => ({ name, kind: "repo", repo: { url, rev: SHA } }));
  writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, scope: "org", members }));
  return root;
}

async function forgeFindings(root: string, text: string) {
  const report = await runDeclarationChecks(root, (f) => f, { forgeRepos: parseForgeRepos(text, "forge.json") });
  return report.diagnostics.filter((d) => d.ruleId === "WSP014" || d.ruleId === "WSP015");
}

describe("forgeRepoList", () => {
  it("writes { forge, org, repos } sorted by url, archived repos marked, subgroups included", async () => {
    expect(JSON.parse(await written())).toEqual({
      forge: "gitlab",
      org: "acme",
      repos: [
        { url: `${BASE}/acme/api` },
        { url: `${BASE}/acme/legacy`, archived: true },
        { url: `${BASE}/acme/platform/runner` },
        { url: `${BASE}/acme/web` },
      ],
    });
  });

  it("reads back through chant's --forge-repos parser", async () => {
    expect(parseForgeRepos(await written(), "forge.json").repos).toEqual([
      { url: `${BASE}/acme/api`, archived: false },
      { url: `${BASE}/acme/legacy`, archived: true },
      { url: `${BASE}/acme/platform/runner`, archived: false },
      { url: `${BASE}/acme/web`, archived: false },
    ]);
  });

  it("passes chant workspace check against an org workspace with the same repos", async () => {
    // Clone URLs in the declaration: chant compares by host and full path.
    const root = orgWorkspace({
      api: `${BASE}/acme/api.git`,
      web: "git@gitlab.example.com:acme/web.git",
      runner: "ssh://git@gitlab.example.com/acme/platform/runner.git",
    });
    expect(await forgeFindings(root, await written())).toEqual([]);
  });

  it("gives WSP014 for a repo the declaration lacks and WSP015 for one the forge no longer has", async () => {
    const root = orgWorkspace({ api: `${BASE}/acme/api.git`, runner: `${BASE}/acme/platform/runner.git`, gone: `${BASE}/acme/gone.git` });
    const findings = await forgeFindings(root, await written());
    expect(findings.map((d) => d.ruleId).sort()).toEqual(["WSP014", "WSP015"]);
    expect(findings.find((d) => d.ruleId === "WSP014")!.message).toContain(`${BASE}/acme/web`);
    expect(findings.find((d) => d.ruleId === "WSP015")!.entity).toBe("gone");
  });

  it("falls back to <baseUrl>/<path_with_namespace> when the instance leaves out web_url", async () => {
    const c = makeClient({}, { [PROJECTS]: [{ path_with_namespace: "acme/platform/api" }] });
    expect((await forgeRepoList(c, "acme", `${BASE}/`)).repos).toEqual([{ url: `${BASE}/acme/platform/api` }]);
  });
});

describe("listGroupProjects", () => {
  it("reads the group, then lists its and its subgroups' projects without shared ones, archived included", async () => {
    const c = client();
    expect(await listGroupProjects(c, "acme")).toHaveLength(4);
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /groups/acme", `PAGINATE ${PROJECTS}`]);
    expect(c.calls[1]!.path).not.toMatch(/archived=/);
  });

  it("encodes a subgroup's full path", async () => {
    const c = makeClient();
    await listGroupProjects(c, "acme/platform");
    expect(c.calls.map((x) => x.path)).toEqual(["/groups/acme%2Fplatform", "/groups/acme%2Fplatform/projects?include_subgroups=true&with_shared=false"]);
  });

  it("throws on a 404 instead of reading a missing group as empty", async () => {
    const c = makeClient({
      "GET /groups/ghost": () => {
        throw new GitLabApiError("GET /groups/ghost returned 404", 404);
      },
    });
    await expect(listGroupProjects(c, "ghost")).rejects.toThrow(/404/);
    expect(c.calls).toHaveLength(1);
  });
});

describe("pickGroup", () => {
  it("takes the policy's only top-level group, or the --group the policy governs", () => {
    expect(pickGroup(["acme"], undefined)).toBe("acme");
    expect(pickGroup(["acme", "acme/platform"], undefined)).toBe("acme");
    expect(pickGroup(["acme", "acme/platform"], "acme/platform")).toBe("acme/platform");
    expect(pickGroup(["acme", "beta"], "beta")).toBe("beta");
  });
  it("refuses several top-level groups without --group, a --group the policy lacks, and no groups", () => {
    expect(() => pickGroup(["acme", "beta"], undefined)).toThrow(/--group/);
    expect(() => pickGroup(["acme"], "other")).toThrow(/not a group the policy governs/);
    expect(() => pickGroup([], undefined)).toThrow(/no group/);
  });
  it("counts only group nodes", () => {
    expect(
      policyGroups({ nodes: { acme: { kind: "group" }, "acme/api": { kind: "project" }, instance: { kind: "instance" } } }),
    ).toEqual(["acme"]);
  });
});

describe("parseReposArgs", () => {
  it("parses --group (or --org) and --out, both optional, with reconcile's defaults", () => {
    expect(parseReposArgs([])).toMatchObject({ config: undefined, group: undefined, out: undefined, configMode: "fold", tokenEnv: "GITLAB_TOKEN" });
    expect(parseReposArgs(["--group", "acme", "--out", "repos.json"])).toMatchObject({ group: "acme", out: "repos.json" });
    expect(parseReposArgs(["--org", "acme"])).toMatchObject({ group: "acme" });
    expect(parseReposArgs(["--config", "g.ts", "--base-url-env", "U", "--token-env", "T", "--config-mode", "run"])).toMatchObject({
      config: "g.ts",
      baseUrlEnv: "U",
      tokenEnv: "T",
      configMode: "run",
    });
  });
  it("throws code 2 on reconcile flags, empty values, positionals and two different groups", () => {
    const bad = (argv: string[]) => expect(() => parseReposArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad(["--mode", "apply"]);
    bad(["--plan-json", "p.json"]);
    bad(["--out"]);
    bad(["--group", ""]);
    bad(["--config-mode", "eval"]);
    bad(["stray"]);
    bad(["--group", "acme", "--org", "beta"]);
  });
});
