/**
 * `previously:` node renames — runner alias resolution (scope adoption under
 * the old path) plus the runner-appended node-rename cycle, driven through
 * warden's runReconcile with the recording mock client.
 */

import { describe, it, expect } from "vitest";
import { makeClient } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import { groupSettingsCycle } from "./group-settings.js";
import { projectSettingsCycle } from "./project-settings.js";
import type { GovernanceConfig } from "../config/types.js";

const notFound = (): never => {
  throw new Error("GitLab API error 404 Not Found");
};

describe("previously: group rename", () => {
  it("plans exactly one update (no delete + create), no `owned` needed", async () => {
    const client = makeClient({ "GET /groups/acme%2Fnew-name": notFound }); // old path GET → {} (live)
    const config: GovernanceConfig = {
      nodes: { "acme/new-name": { kind: "group", previously: "acme/old-name" } },
    };
    const result = await runReconcile({ config, client, cycles: [], mode: "dry-run" });
    expect(result.errored).toEqual([]);
    expect(result.cycles).toHaveLength(1); // just the appended node-rename cycle
    const cr = result.cycles[0]!;
    expect(cr.name).toBe("node-rename");
    expect(cr.org).toBe("group:acme/old-name"); // adopted under the old (live) path
    expect(cr.counts).toEqual({ create: 0, update: 1, delete: 0 });
    expect(cr.guardrails.ok).toBe(true);
    expect(cr.plan).toContain("[node] acme/new-name");
    // Dry-run: the probes are the only requests, and nothing was mutated.
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("applies as one PUT against the old path — path only, curated display name untouched", async () => {
    const client = makeClient({ "GET /groups/acme%2Fnew-name": notFound });
    const config: GovernanceConfig = {
      nodes: { "acme/new-name": { kind: "group", previously: "acme/old-name" } },
    };
    const result = await runReconcile({ config, client, cycles: [], mode: "apply" });
    const cr = result.cycles[0]!;
    expect(cr.applied).toHaveLength(1);
    expect(cr.failed).toEqual([]);
    // No settings slice manages the name, so the PUT must not carry one — a
    // hand-curated display name survives the rename.
    const puts = client.calls.filter((c) => c.method === "PUT");
    expect(puts).toEqual([
      { method: "PUT", path: "/groups/acme%2Fold-name", body: { path: "new-name" } },
    ]);
  });

  it("sends the managed groupSettings.name alongside the path, whatever cycles were selected", async () => {
    const client = makeClient({ "GET /groups/acme%2Fnew-name": notFound });
    const config: GovernanceConfig = {
      nodes: {
        "acme/new-name": { kind: "group", previously: "acme/old-name", groupSettings: { name: "Fancy Name" } },
      },
    };
    // group-settings is deliberately NOT selected: the managed value still
    // rides on the rename PUT because it comes from this run's config.
    await runReconcile({ config, client, cycles: [], mode: "apply" });
    const rename = client.calls.find((c) => c.method === "PUT" && c.path === "/groups/acme%2Fold-name")!;
    expect(rename.body).toEqual({ path: "new-name", name: "Fancy Name" });
  });

  it("runs the other cycles against the old path first; the rename applies last", async () => {
    const client = makeClient({ "GET /groups/acme%2Fnew-name": notFound });
    const config: GovernanceConfig = {
      nodes: {
        "acme/new-name": { kind: "group", previously: "acme/old-name", groupSettings: { description: "d" } },
      },
    };
    const result = await runReconcile({ config, client, cycles: [groupSettingsCycle], mode: "apply" });
    expect(result.errored).toEqual([]);
    const puts = client.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.path)).toEqual(["/groups/acme%2Fold-name", "/groups/acme%2Fold-name"]);
    expect(puts[0]!.body).toEqual({ description: "d" }); // group-settings, old path
    expect(puts[1]!.body).toEqual({ path: "new-name" }); // rename last, path only
  });
});

describe("previously: project rename", () => {
  it("applies as one PUT with path only (project display names are never managed)", async () => {
    const client = makeClient({ "GET /projects/acme%2Fnew-api": notFound });
    const config: GovernanceConfig = {
      nodes: { "acme/new-api": { kind: "project", previously: "acme/old-api" } },
    };
    const result = await runReconcile({ config, client, cycles: [], mode: "apply" });
    const cr = result.cycles[0]!;
    expect(cr.name).toBe("node-rename");
    expect(cr.org).toBe("project:acme/old-api");
    expect(cr.counts).toEqual({ create: 0, update: 1, delete: 0 });
    expect(cr.applied).toHaveLength(1);
    const puts = client.calls.filter((c) => c.method === "PUT");
    expect(puts).toEqual([
      { method: "PUT", path: "/projects/acme%2Fold-api", body: { path: "new-api" } },
    ]);
  });

  it("converges after: once the declared path is live the alias is inert", async () => {
    const client = makeClient(); // every GET succeeds → the declared path is live
    const config: GovernanceConfig = {
      nodes: { "acme/new-api": { kind: "project", previously: "acme/old-api" } },
    };
    const result = await runReconcile({ config, client, cycles: [projectSettingsCycle], mode: "dry-run" });
    expect(result.cycles).toHaveLength(1); // no node-rename cycle appended
    const cr = result.cycles[0]!;
    expect(cr.name).toBe("project-settings");
    expect(cr.org).toBe("project:acme/new-api"); // scope under the declared path again
    expect(cr.counts).toEqual({ create: 0, update: 0, delete: 0 });
  });
});

describe("previously: fallbacks and validation", () => {
  it("an alias with nothing live at either path is a no-op — normal create behavior", async () => {
    const client = makeClient({
      "GET /groups/acme%2Fnew-name": notFound,
      "GET /groups/acme%2Fold-name": notFound,
    });
    const config: GovernanceConfig = {
      nodes: {
        "acme/new-name": { kind: "group", previously: "acme/old-name", groupSettings: { description: "d" } },
      },
    };
    const result = await runReconcile({ config, client, cycles: [groupSettingsCycle], mode: "dry-run" });
    expect(result.cycles).toHaveLength(1); // no node-rename cycle
    const cr = result.cycles[0]!;
    expect(cr.org).toBe("group:acme/new-name");
    expect(cr.counts).toEqual({ create: 1, update: 0, delete: 0 }); // group-settings creates as usual
  });

  it("rejects previously: on an instance node", async () => {
    const config: GovernanceConfig = {
      nodes: { lab: { kind: "instance", previously: "old-lab" } },
    };
    await expect(runReconcile({ config, client: makeClient(), cycles: [] })).rejects.toThrow(/instance nodes/);
  });

  it("rejects a cross-namespace alias (a transfer, not a rename)", async () => {
    const config: GovernanceConfig = {
      nodes: { "acme/api": { kind: "project", previously: "other/api" } },
    };
    await expect(runReconcile({ config, client: makeClient(), cycles: [] })).rejects.toThrow(
      /different parent namespace/,
    );
  });

  it("rejects an alias that is itself a declared node", async () => {
    const config: GovernanceConfig = {
      nodes: {
        "acme/old": { kind: "project" },
        "acme/new": { kind: "project", previously: "acme/old" },
      },
    };
    await expect(runReconcile({ config, client: makeClient(), cycles: [] })).rejects.toThrow(
      /itself a declared node/,
    );
  });

  it('rejects a caller-supplied cycle named "node-rename" (reserved for the runner)', async () => {
    const impostor = {
      name: "node-rename",
      async fetchLive() {
        return {};
      },
      buildDesired(config: { kind: "group" | "project" | "instance" }) {
        return { kind: config.kind };
      },
      async apply() {},
    };
    const config: GovernanceConfig = { nodes: { "acme/api": { kind: "project" } } };
    await expect(runReconcile({ config, client: makeClient(), cycles: [impostor] })).rejects.toThrow(
      /reserved for the runner-managed rename cycle/,
    );
  });

  it("a pending group rename with declared descendant nodes NOTEs the two-run sequence", async () => {
    const client = makeClient({
      "GET /groups/acme%2Fnew-name": notFound, // group alias pending
      "GET /projects/acme%2Fnew-name%2Fapi": notFound, // descendant not live yet either
    });
    const config: GovernanceConfig = {
      nodes: {
        "acme/new-name": { kind: "group", previously: "acme/old-name" },
        "acme/new-name/api": { kind: "project" },
      },
    };
    const result = await runReconcile({ config, client, cycles: [], mode: "dry-run" });
    const rename = result.cycles.find((c) => c.name === "node-rename" && c.org === "group:acme/old-name")!;
    expect(rename.plan).toContain("NOTE: declared descendant node(s) acme/new-name/api still live under");
    expect(rename.plan).toContain("two-run sequence");
  });

  it("rejects the same alias on two nodes", async () => {
    const client = makeClient({
      "GET /projects/acme%2Fa": notFound,
      "GET /projects/acme%2Fb": notFound,
    });
    const config: GovernanceConfig = {
      nodes: {
        "acme/a": { kind: "project", previously: "acme/old" },
        "acme/b": { kind: "project", previously: "acme/old" },
      },
    };
    await expect(runReconcile({ config, client, cycles: [] })).rejects.toThrow(/more than one node/);
  });

  it("contains a non-404 probe failure to its node: alias inert, error recorded, run continues", async () => {
    const boom = (): never => {
      throw new Error("GitLab API error 500 Internal Server Error");
    };
    const client = makeClient({
      "GET /projects/acme%2Fbroken": boom, // this alias's declared-path probe fails
      "GET /projects/acme%2Fnew-api": notFound, // the healthy alias resolves normally
    });
    const config: GovernanceConfig = {
      nodes: {
        "acme/broken": { kind: "project", previously: "acme/broken-old" },
        "acme/new-api": { kind: "project", previously: "acme/old-api" },
      },
    };
    const result = await runReconcile({ config, client, cycles: [], mode: "dry-run" });
    // The failed probe did not abort the run: the healthy rename resolved and
    // its node-rename cycle ran under the adopted old path…
    expect(result.completed).toBe(true);
    expect(result.cycles.map((c) => c.org)).toContain("project:acme/old-api");
    // …while the broken node's failure is surfaced, alias left inert.
    expect(result.errored).toEqual([
      {
        name: "node-rename",
        org: "project:acme/broken",
        stage: "fetchLive",
        error: expect.stringContaining("500"),
      },
    ]);
  });

  it("charges the request budget for the alias probes", async () => {
    const client = makeClient({ "GET /projects/acme%2Fnew-api": notFound });
    const config: GovernanceConfig = {
      nodes: { "acme/new-api": { kind: "project", previously: "acme/old-api" } },
    };
    const result = await runReconcile({ config, client, cycles: [], mode: "dry-run", requestBudget: 10 });
    // Two probes (declared path, then old path) spent from the budget of 10;
    // the appended node-rename cycle performs no reads of its own in dry-run.
    expect(result.budgetRemaining).toBe(8);
  });

  it("ignores an operator-written nodeRename key (the intent channel is runner-owned)", async () => {
    const client = makeClient();
    // NodeConfig has no nodeRename field — an operator can only smuggle one
    // in through unvalidated YAML, modeled here with a cast. It must be inert.
    const config: GovernanceConfig = {
      nodes: {
        "acme/api": {
          kind: "project",
          nodeRename: { fromPath: "acme/hijack", toPath: "acme/api" },
        } as unknown as GovernanceConfig["nodes"][string],
      },
    };
    const result = await runReconcile({ config, client, cycles: [projectSettingsCycle], mode: "apply" });
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]!.name).toBe("project-settings");
    expect(client.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });
});
