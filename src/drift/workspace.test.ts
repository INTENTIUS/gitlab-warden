/**
 * `chant workspace drift --member` over this package's kind: a throwaway chant
 * workspace pins the package (its kinds file and schema, and the graph and
 * drift readers bundled the way `build:graph` and `build:drift` bundle them),
 * and chant's own `readWorkspaceDrift` imports the reader and reads a
 * forge-governance member. GitLab is a stubbed `fetch`; nothing leaves the
 * process.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, test, vi } from "vitest";
import { driftReadDocument, readWorkspaceDrift } from "@intentius/chant/workspace/drift-cli";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const banner = { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" };

/** A chant workspace with one forge-governance member, `forge` in `gitlab/`, and this package installed. */
async function workspace(policy: string): Promise<string> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "gitlab-warden-ws-")));
  dirs.push(ws);
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  };
  write(
    "chant.workspace.json",
    JSON.stringify({ name: "acme", schema: 1, pins: [{ package: pkg.name, version: pkg.version }], members: [{ name: "forge", dir: "gitlab", kind: "forge-governance" }] }, null, 2),
  );
  write("gitlab/governance.yml", policy);
  write(".gitignore", "node_modules\n");
  const installed = join(ws, "node_modules", ...pkg.name.split("/"));
  write(join("node_modules", ...pkg.name.split("/"), "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", exports: pkg.exports }));
  cpSync(join(root, "workspace-kinds.json"), join(installed, "workspace-kinds.json"));
  cpSync(join(root, "schemas"), join(installed, "schemas"), { recursive: true });
  const common = { bundle: true, platform: "node" as const, format: "esm" as const, banner, logLevel: "silent" as const };
  await build({ ...common, entryPoints: [join(root, "src/graph/entry.ts")], outfile: join(installed, "dist/graph-reader.mjs") });
  await build({ ...common, entryPoints: [join(root, "src/drift/entry.ts")], external: ["@intentius/tsad-reference"], outfile: join(installed, "dist/drift-reader.mjs") });
  execFileSync("git", ["init", "-q"], { cwd: ws });
  return ws;
}

/** GitLab, as a fetch: the routes given, an empty page for any other list, an empty object otherwise. Records each REST method (GraphQL reads are POSTs). */
function gitlab(routes: Record<string, unknown>, methods: string[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    if (u.pathname !== "/api/graphql") methods.push(method);
    const key = `${method} ${u.pathname.replace(/^\/api\/v4/, "")}`;
    const body = key in routes ? routes[key] : u.pathname === "/api/graphql" ? { data: {} } : u.searchParams.has("page") ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const POLICY = `nodes:
  acme:
    kind: group
    groupSettings:
      visibility: private
`;

describe("chant workspace drift over the forge-governance kind", () => {
  test("reports drift for a policy GitLab differs from, and none for one it matches", async () => {
    vi.stubEnv("GITLAB_TOKEN", "t0ken");
    vi.stubEnv("GITLAB_BASE_URL", "https://gitlab.example.com");
    const ws = await workspace(POLICY);

    const methods: string[] = [];
    vi.stubGlobal("fetch", gitlab({ "GET /groups/acme": { id: 1, visibility: "public" } }, methods));
    const drifted = await readWorkspaceDrift({ cwd: ws, member: "forge" });
    if ("error" in drifted) throw new Error(`${drifted.error.code}: ${drifted.error.message}`);
    const doc = driftReadDocument("forge", drifted);
    expect(doc.records.map((r) => [r.member, r.engine, r.read, r.address, r.status, r.node])).toEqual([["forge", "warden", "live-read", "team/acme", "drifted", "forge/team/acme"]]);
    expect(doc.records[0].attributes).toContainEqual({ path: "group-settings.visibility", before: "private", after: "public" });
    expect(new Set(methods)).toEqual(new Set(["GET"]));

    vi.stubGlobal("fetch", gitlab({ "GET /groups/acme": { id: 1, visibility: "private" } }));
    const clean = await readWorkspaceDrift({ cwd: ws, member: "forge" });
    if ("error" in clean) throw new Error(`${clean.error.code}: ${clean.error.message}`);
    expect(driftReadDocument("forge", clean).records.map((r) => [r.address, r.status, r.node])).toEqual([["team/acme", "in-sync", "forge/team/acme"]]);
  }, 30_000);

  test("answers no-drift-read when the token variable is unset", async () => {
    vi.stubEnv("GITLAB_TOKEN", "");
    const ws = await workspace(POLICY);
    const answer = await readWorkspaceDrift({ cwd: ws, member: "forge" });
    expect("error" in answer && answer.error.code).toBe("no-drift-read");
  }, 30_000);
});
