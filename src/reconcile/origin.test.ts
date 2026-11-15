import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  annotatePlan,
  configPath,
  driftOrigins,
  formatOrigin,
  formatOrigins,
  originAt,
  type FieldOrigin,
  type PolicyProvenance,
} from "./origin.js";
import { diff, renderChangeSet } from "./diff.js";
import { runReconcile } from "./runner.js";
import { projectSettingsCycle } from "../cycles/project-settings.js";
import { mrApprovalsCycle } from "../cycles/mr-approvals.js";
import { makeClient } from "../cycles/_testutil.js";
import { loadGovernancePolicy } from "../config/load.js";
import type { GovernanceConfig } from "../config/types.js";

const at = (line: number, column: number) => ({ file: "policy.ts", line, column });

const PARAM: FieldOrigin = {
  kind: "composite-parameter",
  composite: "reviewPreset",
  parameters: ["linear"],
  call: at(20, 13),
  arguments: { linear: at(20, 50) },
};
const LITERAL: FieldOrigin = { kind: "composite-literal", composite: "reviewPreset", call: at(20, 13), literal: at(13, 39) };
const DIRECT: FieldOrigin = { kind: "direct" };
const UNKNOWN: FieldOrigin = { kind: "unknown", reason: "host-call" };

const config: GovernanceConfig = {
  nodes: {
    acme: { kind: "group", groupSettings: { description: "Engineering" }, webhooks: [{ url: "https://hooks.example/a/b", previously: "https://hooks.example/old" }] },
    "acme/api": {
      kind: "project",
      previously: "acme/api-old",
      projectSettings: { mergeMethod: "ff", onlyAllowMergeIfPipelineSucceeds: true, description: "api", topics: ["service", "api"] },
      members: [{ user: "alice", accessLevel: "developer" }],
      protectedBranches: [{ name: "release" }, { name: "main", pushAccessLevel: 0 }],
      approvalRules: [{ name: "review", approvalsRequired: 2 }],
      variables: [{ key: "REGION", value: "eu", environmentScope: "prod" }, { key: "REGION", value: "us" }],
      pipelineSchedules: [{ description: "nightly", cron: "0 2 * * *", ref: "main" }],
    },
  },
};

const prov: PolicyProvenance = {
  paths: {
    "nodes.acme.groupSettings.description": DIRECT,
    'nodes["acme/api"].projectSettings.mergeMethod': PARAM,
    'nodes["acme/api"].projectSettings.onlyAllowMergeIfPipelineSucceeds': LITERAL,
    'nodes["acme/api"].projectSettings.description': UNKNOWN,
    'nodes["acme/api"].projectSettings.topics[0]': DIRECT,
    'nodes["acme/api"].projectSettings.topics[1]': UNKNOWN,
    'nodes["acme/api"].protectedBranches[1].pushAccessLevel': LITERAL,
    'nodes["acme/api"].approvalRules[0].approvalsRequired': PARAM,
  },
};

describe("configPath", () => {
  it("maps each resource type's field to its path in the policy, joining list members on their key", () => {
    const p = (scope: string, t: string, k: string, f: string) => configPath(config, scope, t, k, f);
    const api = "project:acme/api";
    expect(p("group:acme", "group-settings", "group-settings", "description")).toBe("nodes.acme.groupSettings.description");
    expect(p(api, "project-settings", "project-settings", "mergeMethod")).toBe('nodes["acme/api"].projectSettings.mergeMethod');
    expect(p(api, "member", "alice", "accessLevel")).toBe('nodes["acme/api"].members[0].accessLevel');
    expect(p(api, "protected-branch", "main", "pushAccessLevel")).toBe('nodes["acme/api"].protectedBranches[1].pushAccessLevel');
    expect(p(api, "approval-rule", "review", "approvalsRequired")).toBe('nodes["acme/api"].approvalRules[0].approvalsRequired');
    expect(p(api, "variable", "REGION@prod", "value")).toBe('nodes["acme/api"].variables[0].value');
    expect(p(api, "variable", "REGION@*", "value")).toBe('nodes["acme/api"].variables[1].value');
    expect(p(api, "pipeline-schedule", "nightly", "cron")).toBe('nodes["acme/api"].pipelineSchedules[0].cron');
    expect(p("group:acme", "webhook", "https://hooks.example/a/b", "key")).toBe("nodes.acme.webhooks[0].previously");
    expect(p(api, "protected-branch", "missing", "pushAccessLevel")).toBeUndefined();
    expect(p(api, "baseline", "child", "path")).toBeUndefined();
    expect(p("group:other", "group-settings", "group-settings", "description")).toBeUndefined();
  });

  it("a pending rename runs under the old path and still finds the declared node", () => {
    expect(configPath(config, "project:acme/api-old", "project-settings", "project-settings", "mergeMethod")).toBe(
      'nodes["acme/api"].projectSettings.mergeMethod',
    );
    expect(configPath(config, "project:acme/api-old", "node", "acme/api", "key")).toBe('nodes["acme/api"].previously');
  });
});

describe("originAt", () => {
  it("an exact leaf, a list's distinct element origins, a path under a reported leaf, and nothing", () => {
    expect(originAt(prov, 'nodes["acme/api"].projectSettings.mergeMethod')).toEqual([PARAM]);
    expect(originAt(prov, 'nodes["acme/api"].projectSettings.topics')).toEqual([DIRECT, UNKNOWN]);
    expect(originAt(prov, "nodes.acme.groupSettings.description.deeper[0]")).toEqual([DIRECT]);
    expect(originAt(prov, 'nodes["acme/api"].projectSettings.defaultBranch')).toEqual([]);
  });
});

describe("formatOrigin", () => {
  it("names the preset argument and its line, the preset body line, direct, and unknown with its reason", () => {
    expect(formatOrigin(PARAM)).toBe("reviewPreset(...) argument linear at policy.ts:20:50");
    expect(formatOrigin(LITERAL)).toBe("reviewPreset(...) sets it in its body at policy.ts:13:39, called at policy.ts:20:13");
    expect(formatOrigin(DIRECT)).toBe("direct");
    expect(formatOrigin(UNKNOWN)).toBe("unknown (host-call)");
  });

  it("a parameter whose default applied has no argument to point at, so the call is named", () => {
    const o: FieldOrigin = { kind: "composite-parameter", composite: "reviewPreset", parameters: ["approvals"], call: at(20, 13) };
    expect(formatOrigin(o)).toBe("reviewPreset(...) parameter approvals (default applied), called at policy.ts:20:13");
  });

  it("nothing reported is unknown, never direct", () => {
    expect(formatOrigins([])).toBe("unknown (not reported)");
  });
});

describe("annotatePlan", () => {
  it("writes each drifted field's origin under its plan line, for all four kinds", () => {
    const api = config.nodes["acme/api"]!;
    const cs = diff(
      "project:acme/api",
      { kind: "project", projectSettings: api.projectSettings, protectedBranches: api.protectedBranches },
      {
        projectSettings: { mergeMethod: "merge", onlyAllowMergeIfPipelineSucceeds: false, description: "drifted", topics: ["service", "api"] },
        protectedBranches: [{ name: "release" }, { name: "main", pushAccessLevel: 30 }],
      },
    );
    const drift = driftOrigins(cs, config, prov);
    expect(drift.map((d) => [d.resourceType, d.field, d.origins.map((o) => o.kind)])).toEqual([
      ["project-settings", "description", ["unknown"]],
      ["project-settings", "mergeMethod", ["composite-parameter"]],
      ["project-settings", "onlyAllowMergeIfPipelineSucceeds", ["composite-literal"]],
      ["protected-branch", "pushAccessLevel", ["composite-literal"]],
    ]);
    const plan = annotatePlan(renderChangeSet(cs), drift);
    expect(plan).toContain(
      [
        "  [project-settings] project-settings",
        "    description: drifted → api",
        "      <- unknown (host-call)",
        "    mergeMethod: merge → ff",
        "      <- reviewPreset(...) argument linear at policy.ts:20:50",
        "    onlyAllowMergeIfPipelineSucceeds: false → true",
        "      <- reviewPreset(...) sets it in its body at policy.ts:13:39, called at policy.ts:20:13",
      ].join("\n"),
    );
    expect(plan).toContain(
      ["  [protected-branch] main", "    pushAccessLevel: 30 → 0", "      <- reviewPreset(...) sets it in its body at policy.ts:13:39, called at policy.ts:20:13"].join("\n"),
    );
  });

  it("a plan with no drift is returned as it was", () => {
    expect(annotatePlan("Plan for x: 0 to create, 0 to update, 0 to delete\nNo changes.", [])).toBe(
      "Plan for x: 0 to create, 0 to update, 0 to delete\nNo changes.",
    );
  });
});

describe("the example policy's preset, folded", () => {
  const policy = "examples/governance.ts";
  const lineOf = (needle: string): number =>
    readFileSync(resolve(policy), "utf-8").split("\n").findIndex((l) => l.includes(needle)) + 1;

  it("a preset-set field resolves to the preset argument on the line the preset is applied", async () => {
    const { provenance } = await loadGovernancePolicy(policy, "fold");
    expect(provenance).toBeDefined();
    const line = lineOf("reviewPreset({ approvals: 2, linear: true })");
    const [origin] = originAt(provenance!, 'nodes["acme/api"].projectSettings.mergeMethod');
    expect(origin).toMatchObject({
      kind: "composite-parameter",
      composite: "reviewPreset",
      parameters: ["linear"],
      arguments: { linear: { file: policy, line } },
    });
    const [approvals] = originAt(provenance!, 'nodes["acme/api"].approvalRules[0].approvalsRequired');
    expect(approvals).toMatchObject({ kind: "composite-parameter", arguments: { approvals: { file: policy, line } } });
    expect(originAt(provenance!, 'nodes["acme/api"].projectSettings.topics')).toEqual([{ kind: "direct" }]);
  });

  it("run mode and YAML carry no provenance; check mode does", async () => {
    expect((await loadGovernancePolicy(policy, "run")).provenance).toBeUndefined();
    expect((await loadGovernancePolicy("examples/governance.yml")).provenance).toBeUndefined();
    expect((await loadGovernancePolicy(policy, "check")).provenance).toBeDefined();
  });

  it("a dry-run against drifted live state names the preset argument and the direct field in the plan", async () => {
    const { config: cfg, provenance } = await loadGovernancePolicy(policy, "fold");
    const client = makeClient(
      {
        // api: merge commits allowed out of band (preset-set), a topic dropped (direct).
        "GET /projects/acme%2Fapi": {
          merge_method: "merge",
          squash_option: "always",
          only_allow_merge_if_pipeline_succeeds: true,
          remove_source_branch_after_merge: true,
          topics: ["api"],
        },
        "GET /projects/acme%2Fweb": {
          merge_method: "merge",
          squash_option: "default_off",
          only_allow_merge_if_pipeline_succeeds: true,
          remove_source_branch_after_merge: true,
          topics: ["service", "web"],
        },
      },
      {
        "/projects/acme%2Fapi/approval_rules": [{ id: 1, name: "review", approvals_required: 1 }],
        "/projects/acme%2Fweb/approval_rules": [{ id: 2, name: "review", approvals_required: 1 }],
      },
    );
    const result = await runReconcile({ config: cfg, client, cycles: [projectSettingsCycle, mrApprovalsCycle], mode: "dry-run", provenance });
    const line = lineOf("reviewPreset({ approvals: 2, linear: true })");
    const settings = result.cycles.find((c) => c.name === projectSettingsCycle.name && c.org === "project:acme/api")!;
    const approvals = result.cycles.find((c) => c.name === mrApprovalsCycle.name && c.org === "project:acme/api")!;
    expect(settings.plan).toContain(
      ["    mergeMethod: merge → ff", `      <- reviewPreset(...) argument linear at ${policy}:${line}:50`].join("\n"),
    );
    expect(settings.plan).toMatch(/ {4}topics: .*\n {6}<- direct/);
    expect(approvals.plan).toContain(
      ["  [approval-rule] review", "    approvalsRequired: 1 → 2", `      <- reviewPreset(...) argument approvals at ${policy}:${line}:39`].join("\n"),
    );
    expect(settings.origins?.find((o) => o.field === "mergeMethod")?.origins[0]?.kind).toBe("composite-parameter");
    if (process.env.SHOW_PLAN) console.log(`${settings.plan}\n\n${approvals.plan}`);
  });

  it("without provenance the plan is chant's, unannotated", async () => {
    const cfg: GovernanceConfig = { nodes: { "acme/api": { kind: "project", projectSettings: { mergeMethod: "ff" } } } };
    const client = makeClient({ "GET /projects/acme%2Fapi": { merge_method: "merge" } });
    const result = await runReconcile({ config: cfg, client, cycles: [projectSettingsCycle], mode: "dry-run" });
    expect(result.cycles[0]!.plan).not.toContain("<-");
    expect(result.cycles[0]!.origins).toBeUndefined();
  });
});
