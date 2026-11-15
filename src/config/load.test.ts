import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadGovernanceConfig, loadGovernancePolicy, GovernanceConfigError } from "./load.js";
import { runReconcile } from "../reconcile/runner.js";
import { CYCLE_REGISTRY } from "../cli/registry.js";
import { makeClient } from "../cycles/_testutil.js";

const ex = (name: string) => resolve(import.meta.dirname, "..", "..", "examples", name);

/** A scratch directory under the OS temp dir; the tests never delete it. */
const scratch = (): string => mkdtempSync(join(tmpdir(), "gitlab-warden-load-"));

describe("loadGovernanceConfig", () => {
  it("a .ts policy folded, a .ts policy run, and the .yml load to the same object", async () => {
    const yml = await loadGovernanceConfig(ex("governance.yml"));
    const folded = await loadGovernanceConfig(ex("governance.ts"), "fold");
    const ran = await loadGovernanceConfig(ex("governance.ts"), "run");
    expect(folded).toEqual(yml);
    expect(ran).toEqual(yml);
    expect(folded.nodes["acme/api"]?.protectedBranches?.[0]?.name).toBe("main");
  });

  it("check mode passes when folding and running agree", async () => {
    await expect(loadGovernanceConfig(ex("governance.ts"), "check")).resolves.toBeTruthy();
  });

  it("a policy that reads the environment is refused by fold and check, with the line, and accepted by run", async () => {
    await expect(loadGovernanceConfig(ex("not-data.ts"))).rejects.toThrow(GovernanceConfigError);
    await expect(loadGovernanceConfig(ex("not-data.ts"))).rejects.toThrow(/not data/);
    await expect(loadGovernanceConfig(ex("not-data.ts"))).rejects.toThrow(/\d+:\d+/);
    await expect(loadGovernanceConfig(ex("not-data.ts"), "check")).rejects.toThrow(/not data/);
    const ran = await loadGovernanceConfig(ex("not-data.ts"), "run");
    expect(ran.nodes["acme/api"]?.projectSettings?.removeSourceBranchAfterMerge).toBe(false);
  });

  it("an undefined property is absent, the way JSON leaves it, so selective-by-omission holds", async () => {
    const p = join(scratch(), "governance.ts");
    writeFileSync(p, 'const on = false;\nexport default { nodes: { "acme/api": { kind: "project", projectSettings: { mergeMethod: on ? "ff" : undefined } } } };\n');
    const folded = await loadGovernanceConfig(p, "fold");
    expect("mergeMethod" in (folded.nodes["acme/api"]?.projectSettings ?? {})).toBe(false);
  });

  it("accepts `export const policy` as well as a default export", async () => {
    const p = join(scratch(), "governance.ts");
    writeFileSync(p, 'export const policy = { nodes: { acme: { kind: "group" } } };\n');
    expect(await loadGovernanceConfig(p)).toEqual({ nodes: { acme: { kind: "group" } } });
  });

  it("refuses a config with no nodes map", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "governance.yml"), "orgs: {}\n");
    await expect(loadGovernanceConfig(join(dir, "governance.yml"))).rejects.toThrow(/nodes/);
    writeFileSync(join(dir, "governance.ts"), "export default { orgs: {} };\n");
    await expect(loadGovernanceConfig(join(dir, "governance.ts"))).rejects.toThrow(/nodes/);
  });

  it("YAML and JSON carry no provenance", async () => {
    expect((await loadGovernancePolicy(ex("governance.yml"))).provenance).toBeUndefined();
    const p = join(scratch(), "governance.json");
    writeFileSync(p, JSON.stringify({ nodes: { acme: { kind: "group" } } }));
    expect(await loadGovernancePolicy(p)).toEqual({ config: { nodes: { acme: { kind: "group" } } } });
  });
});

describe("a .ts policy plans the same as the equivalent YAML", () => {
  // Live state that drifts from the policy on several slices, so the plans
  // carry creates and field-level updates rather than only no-ops.
  const live = () =>
    makeClient(
      {
        "GET /groups/acme": { description: "Old", visibility: "internal" },
        "GET /projects/acme%2Fapi": { merge_method: "merge", squash_option: "default_off", topics: ["api"] },
        "GET /projects/acme%2Fweb": { merge_method: "merge", squash_option: "default_off", topics: ["service", "web"] },
      },
      {
        "/projects/acme%2Fapi/approval_rules": [{ id: 7, name: "review", approvals_required: 1 }],
        "/projects/acme%2Fapi/protected_branches": [
          { name: "main", push_access_levels: [{ access_level: 30 }], merge_access_levels: [{ access_level: 40 }], allow_force_push: false },
        ],
      },
    );

  it("every cycle's plan is identical for governance.yml and governance.ts", async () => {
    const yml = await loadGovernancePolicy(ex("governance.yml"));
    const ts = await loadGovernancePolicy(ex("governance.ts"));
    const cycles = Object.values(CYCLE_REGISTRY);
    const a = await runReconcile({ config: yml.config, client: live(), cycles, mode: "dry-run" });
    const b = await runReconcile({ config: ts.config, client: live(), cycles, mode: "dry-run" });
    const plans = (r: typeof a) => r.cycles.map((c) => ({ name: c.name, org: c.org, counts: c.counts, plan: c.plan }));
    expect(plans(b)).toEqual(plans(a));
    expect(b.changeSets).toEqual(a.changeSets);
    expect(b.errored).toEqual(a.errored);
    // The comparison is not vacuous: the drift above shows up as updates.
    expect(a.cycles.reduce((n, c) => n + c.counts.update, 0)).toBeGreaterThan(0);
  });
});
