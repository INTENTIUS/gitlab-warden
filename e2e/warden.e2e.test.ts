/**
 * Hermetic end-to-end smoke suite — exercises every registered cycle against a
 * REAL GitLab instance (a throwaway Docker Compose GitLab CE stack — see
 * e2e/docker-compose.yml + e2e/bootstrap.sh). Gated and excluded from the
 * default test run; run with `npm run test:e2e:run`.
 *
 * ## Gating
 * Skips entirely unless GITLAB_E2E_URL and GITLAB_E2E_TOKEN are set. The apply
 * smoke (Phase 2) additionally requires GITLAB_E2E_APPLY=1, because it mutates
 * the instance (group, project, users, and instance-level settings) — only
 * point it at a throwaway instance.
 *
 * ## Coverage
 * See e2e/README.md for the cycle-by-cycle table. In short: every cycle that
 * GitLab CE supports gets the full loop — apply from a policy, re-run to a
 * converged (empty) plan, mutate out-of-band and re-run to correct the drift,
 * and (where `owned` applies) a real delete. Premium/Ultimate-gated cycles are
 * asserted tier-graceful instead: the read is tolerated (403/404/absent
 * GraphQL field), the run does not error, and — where GitLab signals the gate
 * as a 403 or a missing GraphQL field — the plan carries a NOTE line. GitLab
 * CE 17.11 returns **404** (not 403) for its REST-gated features (push rules,
 * approvals, protected environments, member roles), so on CE those plan
 * optimistically without a NOTE; the GraphQL cycles (compliance-frameworks,
 * security-policies) do exercise the NOTE path via the missing-field gate.
 *
 * ## Phases
 *   1 (always): per cycle × {group, project} node, fetchLive + diff; assert
 *     every call was read-only (no POST/PUT/PATCH/DELETE).
 *   2 (GITLAB_E2E_APPLY=1): the full smoke, one describe per cycle.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { createClient, encodeId, type GitLabClient } from "../src/auth/client.js";
import { runMigrate } from "../src/migrate/migrate.js";
import { parseMigrateArgs } from "../src/migrate/args.js";
import { CYCLE_REGISTRY } from "../src/cli/registry.js";
import { diff } from "../src/reconcile/diff.js";
import { runReconcile, nodeScopeId, type RateBudget, type CycleResult, type ReconcileResult } from "../src/reconcile/runner.js";
import type { GovernanceConfig, NodeConfig } from "../src/config/types.js";

const ENV = process.env;
const URL = ENV.GITLAB_E2E_URL;
const TOKEN = ENV.GITLAB_E2E_TOKEN;
const APPLY = ENV.GITLAB_E2E_APPLY === "1";

const configured = Boolean(URL && TOKEN);
const suite = configured ? describe : describe.skip;
if (!configured) {
  // eslint-disable-next-line no-console
  console.warn("[e2e] skipped — run e2e/bootstrap.sh and set GITLAB_E2E_URL / GITLAB_E2E_TOKEN.");
}
const applySuite = configured && APPLY ? describe : describe.skip;
if (configured && !APPLY) {
  // eslint-disable-next-line no-console
  console.warn("[e2e] apply smoke skipped — set GITLAB_E2E_APPLY=1 (throwaway instances only).");
}

const RUN = `${ENV.GITHUB_RUN_ID ?? Date.now()}`.toLowerCase();
const GROUP_PATH = `warden-e2e-${RUN}`;
const PROJECT_NAME = "probe";
const PROJECT_PATH = `${GROUP_PATH}/${PROJECT_NAME}`;
const SMOKE_USER = `warden-smoke-${RUN}`;
const GROUP_NODE = nodeScopeId("group", GROUP_PATH);
const PROJECT_NODE = nodeScopeId("project", PROJECT_PATH);

// Throwaway key for the deploy-keys smoke (its private half was discarded).
const SMOKE_SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeEsDo+z46N7eB7yL/2MDup24brMuClyvahApoVvMqs gitlab-warden-e2e-smoke";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function makeBudget(initial = 500): RateBudget {
  let remaining = initial;
  return {
    get remaining() {
      return remaining;
    },
    get exhausted() {
      return remaining <= 0;
    },
    use(n = 1) {
      remaining = Math.max(0, remaining - n);
    },
  };
}

interface Call {
  method: string;
}
function recording(inner: GitLabClient): { client: GitLabClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ method });
        return inner.request<T>(method, path, body);
      },
      async paginate<T = unknown>(path: string, perPage?: number): Promise<T[]> {
        calls.push({ method: "GET" });
        return inner.paginate<T>(path, perPage);
      },
      async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
        calls.push({ method: "GRAPHQL" });
        return inner.graphql<T>(query, variables);
      },
    },
  };
}

suite("gitlab-warden e2e (Docker GitLab CE)", () => {
  let client: GitLabClient;
  let groupId: number | undefined;
  let projectId: number | undefined;
  let smokeUserId: number | undefined;

  // ── Reconcile helpers: drive one cycle through warden's real runner ───────

  /** Run one cycle over the given policy nodes via warden's runReconcile. */
  async function reconcile(
    cycleName: string,
    nodes: GovernanceConfig["nodes"],
    mode: "dry-run" | "apply",
    opts: { removalDeltaCapFraction?: number } = {},
  ): Promise<ReconcileResult> {
    const cycle = CYCLE_REGISTRY[cycleName];
    if (!cycle) throw new Error(`unknown cycle: ${cycleName}`);
    return runReconcile({ config: { nodes }, client, cycles: [cycle], mode, ...opts });
  }

  /** The single cycle result of a one-node run; asserts the run didn't error. */
  function one(result: ReconcileResult): CycleResult {
    expect(result.errored).toEqual([]);
    expect(result.cycles).toHaveLength(1);
    return result.cycles[0]!;
  }

  /** Assert a clean apply: no errors, no failures, not guardrail-blocked. */
  function applied(result: ReconcileResult): CycleResult {
    const cr = one(result);
    expect(cr.failed).toEqual([]);
    expect(cr.guardrailBlocked).toBe(false);
    return cr;
  }

  /** Assert a converged (empty) plan. */
  function converged(result: ReconcileResult): void {
    const cr = one(result);
    expect(cr.counts).toEqual({ create: 0, update: 0, delete: 0 });
  }

  beforeAll(async () => {
    client = createClient({ baseUrl: URL!, token: TOKEN! });

    const group = await client.request<{ id: number }>("POST", "/groups", { name: GROUP_PATH, path: GROUP_PATH, visibility: "private" });
    groupId = group.id;
    const project = await client.request<{ id: number }>("POST", "/projects", {
      name: PROJECT_NAME,
      path: PROJECT_NAME,
      namespace_id: groupId,
      visibility: "private",
      initialize_with_readme: true,
      description: "warden e2e — auto-created, safe to delete",
    });
    projectId = project.id;
  }, 180_000);

  afterAll(async () => {
    if (projectId !== undefined) await client.request("DELETE", `/projects/${projectId}`).catch(() => {});
    if (groupId !== undefined) await client.request("DELETE", `/groups/${groupId}`).catch(() => {});
    if (smokeUserId !== undefined) await client.request("DELETE", `/users/${smokeUserId}?hard_delete=true`).catch(() => {});
    // Instance-level leftovers (in case the instance-governance smoke failed midway).
    await client.request("DELETE", "/admin/ci/variables/SMOKE_IVAR").catch(() => {});
  }, 120_000);

  // ── Phase 1: every cycle's read path is read-only on both node kinds ──────
  const nodes = [
    { id: GROUP_NODE, cfg: (): NodeConfig => ({ kind: "group", groupSettings: { description: "x" } }) },
    { id: PROJECT_NODE, cfg: (): NodeConfig => ({ kind: "project", projectSettings: { description: "x" } }) },
  ];

  for (const cycle of Object.values(CYCLE_REGISTRY)) {
    for (const node of nodes) {
      it(`${cycle.name} @ ${node.id.split(":")[0]}: fetchLive is read-only`, async () => {
        const rec = recording(client);
        try {
          const live = await cycle.fetchLive(rec.client, node.id, {}, makeBudget());
          const changeSet = diff(node.id, cycle.buildDesired(node.cfg(), node.id, {}), live, {});
          expect(Array.isArray(changeSet.entries)).toBe(true);
        } catch (err) {
          // CE lacks Premium/Ultimate features; tolerate, but the read path must
          // never have mutated before failing.
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(`[e2e] ${cycle.name} @ ${node.id}: ${msg.slice(0, 120)}`);
        }
        expect(rec.calls.filter((c) => MUTATING.has(c.method))).toEqual([]);
      }, 120_000);
    }
  }

  // ── Phase 2: the apply smoke — every behavior CE can validate ─────────────

  applySuite("smoke: group-settings", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [GROUP_PATH]: { kind: "group", groupSettings: { description: "smoke v1" } },
    });

    it("applies the declared description", async () => {
      const cr = applied(await reconcile("group-settings", node(), "apply"));
      expect(cr.applied.length).toBeGreaterThan(0);
      const got = await client.request<{ description?: string }>("GET", `/groups/${groupId}`);
      expect(got.description).toBe("smoke v1");
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("group-settings", node(), "dry-run"));
    });

    it("corrects out-of-band drift", async () => {
      await client.request("PUT", `/groups/${groupId}`, { description: "drifted out-of-band" });
      const cr = applied(await reconcile("group-settings", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const got = await client.request<{ description?: string }>("GET", `/groups/${groupId}`);
      expect(got.description).toBe("smoke v1");
    });
  });

  applySuite("smoke: project-settings", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: { kind: "project", projectSettings: { description: "smoke v1", topics: ["governance", "warden"] } },
    });

    it("applies description + topics", async () => {
      applied(await reconcile("project-settings", node(), "apply"));
      const got = await client.request<{ description?: string; topics?: string[] }>("GET", `/projects/${projectId}`);
      expect(got.description).toBe("smoke v1");
      expect([...(got.topics ?? [])].sort()).toEqual(["governance", "warden"]);
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("project-settings", node(), "dry-run"));
    });

    it("corrects out-of-band drift", async () => {
      await client.request("PUT", `/projects/${projectId}`, { description: "drifted" });
      const cr = applied(await reconcile("project-settings", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const got = await client.request<{ description?: string }>("GET", `/projects/${projectId}`);
      expect(got.description).toBe("smoke v1");
    });
  });

  applySuite("smoke: members", () => {
    const membersOf = (users: Array<[string, number]>): NodeConfig => ({
      kind: "group",
      members: users.map(([user, accessLevel]) => ({ user, accessLevel })),
    });
    const both = (): GovernanceConfig["nodes"] => ({
      [GROUP_PATH]: membersOf([["root", 50], [SMOKE_USER, 30]]),
    });

    beforeAll(async () => {
      const u = await client.request<{ id: number }>("POST", "/users", {
        email: `${SMOKE_USER}@example.com`,
        username: SMOKE_USER,
        name: "Warden Smoke",
        password: "Zx9QvK3mNt8RpLb2WdHf",
        skip_confirmation: true,
      });
      smokeUserId = u.id;
    }, 120_000);

    it("adds a declared member", async () => {
      const cr = applied(await reconcile("members", both(), "apply"));
      expect(cr.counts.create).toBe(1);
      const roster = await client.paginate<{ username: string; access_level: number }>(`/groups/${groupId}/members`);
      expect(roster.find((m) => m.username === SMOKE_USER)?.access_level).toBe(30);
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("members", both(), "dry-run"));
    });

    it("corrects an out-of-band access-level change", async () => {
      await client.request("PUT", `/groups/${groupId}/members/${smokeUserId}`, { access_level: 40 });
      const cr = applied(await reconcile("members", both(), "apply"));
      expect(cr.counts.update).toBe(1);
      const roster = await client.paginate<{ username: string; access_level: number }>(`/groups/${groupId}/members`);
      expect(roster.find((m) => m.username === SMOKE_USER)?.access_level).toBe(30);
    });

    it("removalDeltaCap blocks removing 1 of 2 live members at the default 25%, naming the type", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [GROUP_PATH]: { ...membersOf([["root", 50]]), owned: ["member"] },
      };
      const cr = one(await reconcile("members", ownedNode, "apply"));
      expect(cr.counts.delete).toBe(1);
      expect(cr.guardrailBlocked).toBe(true);
      expect(cr.guardrails.ok).toBe(false);
      if (!cr.guardrails.ok) {
        expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalDeltaCap");
        expect(cr.guardrails.diagnostics[0]!.message).toContain("1 of 2 live member entries");
      }
    });

    it("deletes the undeclared member at a cap the per-type live denominator satisfies", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [GROUP_PATH]: { ...membersOf([["root", 50]]), owned: ["member"] },
      };
      // 1 delete of 2 live members is exactly 50%. Plan-relative the plan is
      // the single delete (root is converged) — 1/1 = 100% would block — so
      // this passes only because the denominator is the type's LIVE count.
      const cr = applied(await reconcile("members", ownedNode, "apply", { removalDeltaCapFraction: 0.5 }));
      expect(cr.counts.delete).toBe(1);
      const roster = await client.paginate<{ username: string }>(`/groups/${groupId}/members`);
      expect(roster.map((m) => m.username)).toEqual(["root"]);
    });
  });

  applySuite("smoke: protected-branches", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: {
        kind: "project",
        protectedBranches: [
          { name: "main", pushAccessLevel: 40, mergeAccessLevel: 40 },
          { name: "smoke-*", pushAccessLevel: 0, mergeAccessLevel: 40 },
        ],
      },
    });

    it("protects a declared branch pattern (default `main` protection converges)", async () => {
      const cr = applied(await reconcile("protected-branches", node(), "apply"));
      expect(cr.counts.create).toBe(1); // smoke-* — main is already live at 40/40
      const live = await client.paginate<{ name: string }>(`/projects/${projectId}/protected_branches`);
      expect(live.map((b) => b.name).sort()).toEqual(["main", "smoke-*"]);
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("protected-branches", node(), "dry-run"));
    });

    it("re-protects after an out-of-band unprotect", async () => {
      await client.request("DELETE", `/projects/${projectId}/protected_branches/${encodeId("smoke-*")}`);
      const cr = applied(await reconcile("protected-branches", node(), "apply"));
      expect(cr.counts.create).toBe(1);
      const live = await client.paginate<{ name: string }>(`/projects/${projectId}/protected_branches`);
      expect(live.map((b) => b.name)).toContain("smoke-*");
    });

    it("deletes an undeclared protection under `owned` (1 of 2 live passes at 0.5)", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: {
          kind: "project",
          owned: ["protected-branch"],
          protectedBranches: [{ name: "main", pushAccessLevel: 40, mergeAccessLevel: 40 }],
        },
      };
      // Plan-relative this lone delete would read 1/1 = 100%; the per-type
      // live denominator (2 protections live) makes 0.5 a sufficient cap.
      const cr = applied(await reconcile("protected-branches", ownedNode, "apply", { removalDeltaCapFraction: 0.5 }));
      expect(cr.counts.delete).toBe(1);
      const live = await client.paginate<{ name: string }>(`/projects/${projectId}/protected_branches`);
      expect(live.map((b) => b.name)).toEqual(["main"]);
    });
  });

  applySuite("smoke: protected-tags", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: { kind: "project", protectedTags: [{ name: "v*", createAccessLevel: 40 }] },
    });

    it("protects a declared tag pattern", async () => {
      const cr = applied(await reconcile("protected-tags", node(), "apply"));
      expect(cr.counts.create).toBe(1);
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("protected-tags", node(), "dry-run"));
    });

    it("re-protects after an out-of-band unprotect", async () => {
      await client.request("DELETE", `/projects/${projectId}/protected_tags/${encodeId("v*")}`);
      const cr = applied(await reconcile("protected-tags", node(), "apply"));
      expect(cr.counts.create).toBe(1);
    });

    it("deletes an undeclared protection under `owned`", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", owned: ["protected-tag"], protectedTags: [] },
      };
      const cr = applied(await reconcile("protected-tags", ownedNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(1);
      const live = await client.paginate<{ name: string }>(`/projects/${projectId}/protected_tags`);
      expect(live).toEqual([]);
    });
  });

  applySuite("smoke: ci-variables", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: { kind: "project", variables: [{ key: "SMOKE_VAR", value: "one" }] },
    });

    it("creates a declared variable", async () => {
      const cr = applied(await reconcile("ci-variables", node(), "apply"));
      expect(cr.counts.create).toBe(1);
      const got = await client.request<{ value?: string }>("GET", `/projects/${projectId}/variables/SMOKE_VAR`);
      expect(got.value).toBe("one");
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("ci-variables", node(), "dry-run"));
    });

    it("corrects an out-of-band value change", async () => {
      await client.request("PUT", `/projects/${projectId}/variables/SMOKE_VAR`, { value: "drifted" });
      const cr = applied(await reconcile("ci-variables", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const got = await client.request<{ value?: string }>("GET", `/projects/${projectId}/variables/SMOKE_VAR`);
      expect(got.value).toBe("one");
    });

    it("deletes an undeclared variable under `owned`", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", owned: ["variable"], variables: [] },
      };
      const cr = applied(await reconcile("ci-variables", ownedNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(1);
      const live = await client.paginate<{ key: string }>(`/projects/${projectId}/variables`);
      expect(live).toEqual([]);
    });
  });

  applySuite("smoke: pipeline-schedules", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: {
        kind: "project",
        pipelineSchedules: [
          {
            description: "smoke-nightly",
            cron: "0 2 * * *",
            cronTimezone: "UTC",
            ref: "main",
            active: true,
            variables: [{ key: "SCHEDULE_KIND", value: "nightly" }],
          },
        ],
      },
    });

    async function liveSchedules(): Promise<Array<{ id: number; description: string; cron: string }>> {
      return client.paginate(`/projects/${projectId}/pipeline_schedules`);
    }

    it("creates a declared schedule with its variables", async () => {
      const cr = applied(await reconcile("pipeline-schedules", node(), "apply"));
      expect(cr.counts.create).toBe(1);
      const live = await liveSchedules();
      const made = live.find((s) => s.description === "smoke-nightly");
      expect(made?.cron).toBe("0 2 * * *");
      const full = await client.request<{ variables?: Array<{ key: string; value: string }> }>(
        "GET",
        `/projects/${projectId}/pipeline_schedules/${made!.id}`,
      );
      expect(full.variables).toHaveLength(1);
      expect(full.variables![0]).toMatchObject({ key: "SCHEDULE_KIND", value: "nightly", variable_type: "env_var" });
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("pipeline-schedules", node(), "dry-run"));
    });

    it("corrects out-of-band cron and variable drift", async () => {
      const sid = (await liveSchedules()).find((s) => s.description === "smoke-nightly")!.id;
      await client.request("PUT", `/projects/${projectId}/pipeline_schedules/${sid}`, { cron: "0 5 * * *" });
      await client.request("PUT", `/projects/${projectId}/pipeline_schedules/${sid}/variables/SCHEDULE_KIND`, {
        value: "drifted",
      });
      const cr = applied(await reconcile("pipeline-schedules", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const after = await client.request<{ cron: string; variables?: Array<{ key: string; value: string }> }>(
        "GET",
        `/projects/${projectId}/pipeline_schedules/${sid}`,
      );
      expect(after.cron).toBe("0 2 * * *");
      expect(after.variables?.find((v) => v.key === "SCHEDULE_KIND")?.value).toBe("nightly");
    });

    it("deletes an undeclared schedule under `owned`", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", owned: ["pipeline-schedule"], pipelineSchedules: [] },
      };
      const cr = applied(await reconcile("pipeline-schedules", ownedNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(1);
      expect(await liveSchedules()).toEqual([]);
    });
  });

  applySuite("smoke: webhooks", () => {
    const HOOK_URL = "https://smoke.example.com/hook";
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: { kind: "project", webhooks: [{ url: HOOK_URL, pushEvents: true, mergeRequestsEvents: false }] },
    });

    it("creates a declared webhook", async () => {
      const cr = applied(await reconcile("webhooks", node(), "apply"));
      expect(cr.counts.create).toBe(1);
      const live = await client.paginate<{ url: string; push_events: boolean }>(`/projects/${projectId}/hooks`);
      expect(live.find((h) => h.url === HOOK_URL)?.push_events).toBe(true);
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("webhooks", node(), "dry-run"));
    });

    it("corrects an out-of-band event toggle", async () => {
      const live = await client.paginate<{ id: number; url: string }>(`/projects/${projectId}/hooks`);
      const id = live.find((h) => h.url === HOOK_URL)!.id;
      await client.request("PUT", `/projects/${projectId}/hooks/${id}`, { url: HOOK_URL, push_events: false });
      const cr = applied(await reconcile("webhooks", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const after = await client.paginate<{ url: string; push_events: boolean }>(`/projects/${projectId}/hooks`);
      expect(after.find((h) => h.url === HOOK_URL)?.push_events).toBe(true);
    });

    it("deletes an undeclared webhook under `owned`", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", owned: ["webhook"], webhooks: [] },
      };
      const cr = applied(await reconcile("webhooks", ownedNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(1);
      const live = await client.paginate<{ url: string }>(`/projects/${projectId}/hooks`);
      expect(live).toEqual([]);
    });

    it("previously: renames a hook URL in place, keeping the hook id", async () => {
      const OLD_URL = "https://smoke.example.com/hook-old";
      const NEW_URL = "https://smoke.example.com/hook-new";
      const made = await client.request<{ id: number }>("POST", `/projects/${projectId}/hooks`, { url: OLD_URL, push_events: true });
      const renamed: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", webhooks: [{ url: NEW_URL, previously: OLD_URL, pushEvents: true }] },
      };
      const cr = applied(await reconcile("webhooks", renamed, "apply"));
      expect(cr.counts).toEqual({ create: 0, update: 1, delete: 0 });
      const live = await client.paginate<{ id: number; url: string }>(`/projects/${projectId}/hooks`);
      expect(live.map((h) => h.url)).toEqual([NEW_URL]);
      expect(live[0]!.id).toBe(made.id);
      converged(await reconcile("webhooks", renamed, "dry-run"));
      await client.request("DELETE", `/projects/${projectId}/hooks/${made.id}`);
    });
  });

  applySuite("smoke: node rename (previously:)", () => {
    let renProjectId: number | undefined;
    let renGroupId: number | undefined;

    afterAll(async () => {
      if (renProjectId !== undefined) await client.request("DELETE", `/projects/${renProjectId}`).catch(() => {});
      if (renGroupId !== undefined) await client.request("DELETE", `/groups/${renGroupId}`).catch(() => {});
    }, 60_000);

    it("renames a project in place: one update, same project id, converged after", async () => {
      const made = await client.request<{ id: number }>("POST", "/projects", {
        name: "ren-old",
        path: "ren-old",
        namespace_id: groupId,
        visibility: "private",
      });
      renProjectId = made.id;

      const nodes: GovernanceConfig["nodes"] = {
        [`${GROUP_PATH}/ren-new`]: { kind: "project", previously: `${GROUP_PATH}/ren-old` },
      };
      // The node-rename cycle is runner-managed (appended when a rename is
      // pending), so no registry cycle is selected here.
      const result = await runReconcile({ config: { nodes }, client, cycles: [], mode: "apply" });
      expect(result.errored).toEqual([]);
      expect(result.cycles).toHaveLength(1);
      const cr = result.cycles[0]!;
      expect(cr.name).toBe("node-rename");
      expect(cr.counts).toEqual({ create: 0, update: 1, delete: 0 }); // one update, never delete + create
      expect(cr.failed).toEqual([]);

      const live = await client.request<{ id: number }>("GET", `/projects/${encodeId(`${GROUP_PATH}/ren-new`)}`);
      expect(live.id).toBe(made.id); // same project, new path

      // Converged: the alias is inert and the scope runs under the new path.
      const again = await runReconcile({
        config: { nodes: { [`${GROUP_PATH}/ren-new`]: { kind: "project", previously: `${GROUP_PATH}/ren-old` } } },
        client,
        cycles: [CYCLE_REGISTRY["project-settings"]!],
        mode: "dry-run",
      });
      expect(again.errored).toEqual([]);
      expect(again.cycles).toHaveLength(1); // no node-rename appended
      expect(again.cycles[0]!.org).toBe(`project:${GROUP_PATH}/ren-new`);
      expect(again.cycles[0]!.counts).toEqual({ create: 0, update: 0, delete: 0 });
    }, 120_000);

    it("renames a group in place: one update, same group id, converged after", async () => {
      const made = await client.request<{ id: number }>("POST", "/groups", {
        name: "ren-grp-old",
        path: "ren-grp-old",
        parent_id: groupId,
        visibility: "private",
      });
      renGroupId = made.id;

      const nodes: GovernanceConfig["nodes"] = {
        [`${GROUP_PATH}/ren-grp-new`]: { kind: "group", previously: `${GROUP_PATH}/ren-grp-old` },
      };
      const result = await runReconcile({ config: { nodes }, client, cycles: [], mode: "apply" });
      expect(result.errored).toEqual([]);
      expect(result.cycles).toHaveLength(1);
      const cr = result.cycles[0]!;
      expect(cr.name).toBe("node-rename");
      expect(cr.counts).toEqual({ create: 0, update: 1, delete: 0 });
      expect(cr.failed).toEqual([]);

      const live = await client.request<{ id: number }>("GET", `/groups/${encodeId(`${GROUP_PATH}/ren-grp-new`)}`);
      expect(live.id).toBe(made.id);

      const again = await runReconcile({
        config: { nodes: { [`${GROUP_PATH}/ren-grp-new`]: { kind: "group", previously: `${GROUP_PATH}/ren-grp-old` } } },
        client,
        cycles: [CYCLE_REGISTRY["group-settings"]!],
        mode: "dry-run",
      });
      expect(again.errored).toEqual([]);
      expect(again.cycles).toHaveLength(1);
      expect(again.cycles[0]!.org).toBe(`group:${GROUP_PATH}/ren-grp-new`);
      expect(again.cycles[0]!.counts).toEqual({ create: 0, update: 0, delete: 0 });
    }, 120_000);
  });

  applySuite("smoke: deploy-keys-tokens", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: {
        kind: "project",
        deployKeys: [{ title: "smoke-key", key: SMOKE_SSH_KEY, canPush: false }],
        deployTokens: [{ name: "smoke-token", scopes: ["read_repository"] }],
      },
    });

    it("creates a declared deploy key and deploy token", async () => {
      const cr = applied(await reconcile("deploy-keys-tokens", node(), "apply"));
      expect(cr.counts.create).toBe(2);
      const keys = await client.paginate<{ title: string }>(`/projects/${projectId}/deploy_keys`);
      expect(keys.map((k) => k.title)).toContain("smoke-key");
      const tokens = await client.paginate<{ name: string }>(`/projects/${projectId}/deploy_tokens`);
      expect(tokens.map((t) => t.name)).toContain("smoke-token");
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("deploy-keys-tokens", node(), "dry-run"));
    });

    it("corrects an out-of-band can_push flip", async () => {
      const keys = await client.paginate<{ id: number; title: string }>(`/projects/${projectId}/deploy_keys`);
      const id = keys.find((k) => k.title === "smoke-key")!.id;
      await client.request("PUT", `/projects/${projectId}/deploy_keys/${id}`, { can_push: true });
      const cr = applied(await reconcile("deploy-keys-tokens", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const after = await client.paginate<{ title: string; can_push: boolean }>(`/projects/${projectId}/deploy_keys`);
      expect(after.find((k) => k.title === "smoke-key")?.can_push).toBe(false);
    });

    it("deletes undeclared key + token under `owned`", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", owned: ["deploy-key", "deploy-token"], deployKeys: [], deployTokens: [] },
      };
      const cr = applied(await reconcile("deploy-keys-tokens", ownedNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(2);
      expect(await client.paginate(`/projects/${projectId}/deploy_keys`)).toEqual([]);
      expect(await client.paginate(`/projects/${projectId}/deploy_tokens`)).toEqual([]);
    });
  });

  applySuite("smoke: access-tokens", () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: {
        kind: "project",
        accessTokens: [{ name: "smoke-bot", scopes: ["read_api"], accessLevel: 30, expiresAt }],
      },
    });

    it("creates a declared bot token", async () => {
      const cr = applied(await reconcile("access-tokens", node(), "apply"));
      expect(cr.counts.create).toBe(1);
      const live = await client.paginate<{ name: string; active: boolean }>(`/projects/${projectId}/access_tokens`);
      expect(live.find((t) => t.name === "smoke-bot")?.active).toBe(true);
    });

    it("re-run converges to an empty plan (tokens reconcile by presence)", async () => {
      converged(await reconcile("access-tokens", node(), "dry-run"));
    });

    it("revokes an undeclared token under `owned`", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", owned: ["access-token"], accessTokens: [] },
      };
      const cr = applied(await reconcile("access-tokens", ownedNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(1);
      const live = await client.paginate<{ name: string; revoked: boolean; active: boolean }>(
        `/projects/${projectId}/access_tokens`,
      );
      expect(live.filter((t) => t.name === "smoke-bot" && t.active && !t.revoked)).toEqual([]);
    });
  });

  applySuite("smoke: integrations", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: {
        kind: "project",
        integrations: [{ name: "emails-on-push", properties: { recipients: "smoke@example.com" } }],
      },
    });

    it("enables a declared integration", async () => {
      const cr = applied(await reconcile("integrations", node(), "apply"));
      expect(cr.counts.create).toBe(1);
      const live = await client.paginate<{ slug: string; active: boolean }>(`/projects/${projectId}/integrations`);
      expect(live.find((i) => i.slug === "emails-on-push")?.active).toBe(true);
    });

    it("re-run converges to an empty plan (properties are write-only)", async () => {
      converged(await reconcile("integrations", node(), "dry-run"));
    });

    it("declared `active: false` deactivates via the DELETE path (audit finding 1)", async () => {
      const offNode: GovernanceConfig["nodes"] = {
        [PROJECT_PATH]: { kind: "project", integrations: [{ name: "emails-on-push", active: false }] },
      };
      const cr = applied(await reconcile("integrations", offNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(1);
      const live = await client.paginate<{ slug: string; active: boolean }>(`/projects/${projectId}/integrations`);
      expect(live.filter((i) => i.slug === "emails-on-push" && i.active)).toEqual([]);
      // …and the declared-off state is converged, not re-planned:
      converged(await reconcile("integrations", offNode, "dry-run"));
    });
  });

  applySuite("smoke: advanced-protections (job token scope)", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [PROJECT_PATH]: { kind: "project", jobTokenScope: { inboundEnabled: false } },
    });

    it("applies the declared inbound job-token scope", async () => {
      const cr = applied(await reconcile("advanced-protections", node(), "apply"));
      expect(cr.counts.update).toBe(1); // CE default is inbound_enabled: true
      const got = await client.request<{ inbound_enabled: boolean }>("GET", `/projects/${projectId}/job_token_scope`);
      expect(got.inbound_enabled).toBe(false);
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("advanced-protections", node(), "dry-run"));
    });

    it("corrects an out-of-band re-enable", async () => {
      await client.request("PATCH", `/projects/${projectId}/job_token_scope`, { enabled: true });
      const cr = applied(await reconcile("advanced-protections", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const got = await client.request<{ inbound_enabled: boolean }>("GET", `/projects/${projectId}/job_token_scope`);
      expect(got.inbound_enabled).toBe(false);
    });
  });

  applySuite("smoke: baseline (provisioning)", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      [GROUP_PATH]: { kind: "group", baselines: [{ kind: "project", path: "smoke-child" }] },
    });

    it("creates a declared child project", async () => {
      const cr = applied(await reconcile("baseline", node(), "apply"));
      expect(cr.counts.create).toBe(1);
      const got = await client.request<{ path?: string }>("GET", `/projects/${encodeId(`${GROUP_PATH}/smoke-child`)}`);
      expect(got.path).toBe("smoke-child");
    });

    it("re-run converges (existence-only; never updates or deletes)", async () => {
      converged(await reconcile("baseline", node(), "dry-run"));
    });
  });

  applySuite("smoke: instance-governance", () => {
    const node = (): GovernanceConfig["nodes"] => ({
      self: {
        kind: "instance",
        instanceSettings: { signup_enabled: false },
        systemHooks: [{ url: "https://smoke.example.com/sys-hook" }],
        instanceVariables: [{ key: "SMOKE_IVAR", value: "one" }],
      },
    });

    it("applies settings, a system hook, and an instance variable", async () => {
      const cr = applied(await reconcile("instance-governance", node(), "apply"));
      expect(cr.counts.create).toBeGreaterThanOrEqual(2); // hook + variable
      const vars = await client.paginate<{ key: string; value: string }>("/admin/ci/variables");
      expect(vars.find((v) => v.key === "SMOKE_IVAR")?.value).toBe("one");
      const hooks = await client.paginate<{ url: string }>("/hooks");
      expect(hooks.map((h) => h.url)).toContain("https://smoke.example.com/sys-hook");
      const settings = await client.request<{ signup_enabled?: boolean }>("GET", "/application/settings");
      expect(settings.signup_enabled).toBe(false);
    });

    it("re-run converges to an empty plan", async () => {
      converged(await reconcile("instance-governance", node(), "dry-run"));
    });

    it("corrects an out-of-band variable change", async () => {
      await client.request("PUT", "/admin/ci/variables/SMOKE_IVAR", { value: "drifted" });
      const cr = applied(await reconcile("instance-governance", node(), "apply"));
      expect(cr.counts.update).toBe(1);
      const vars = await client.paginate<{ key: string; value: string }>("/admin/ci/variables");
      expect(vars.find((v) => v.key === "SMOKE_IVAR")?.value).toBe("one");
    });

    it("deletes undeclared hook + variable under `owned`", async () => {
      const ownedNode: GovernanceConfig["nodes"] = {
        self: { kind: "instance", owned: ["system-hook", "instance-variable"], systemHooks: [], instanceVariables: [] },
      };
      const cr = applied(await reconcile("instance-governance", ownedNode, "apply", { removalDeltaCapFraction: 1 }));
      expect(cr.counts.delete).toBe(2);
      const vars = await client.paginate<{ key: string }>("/admin/ci/variables");
      expect(vars.filter((v) => v.key === "SMOKE_IVAR")).toEqual([]);
      const hooks = await client.paginate<{ url: string }>("/hooks");
      expect(hooks.filter((h) => h.url === "https://smoke.example.com/sys-hook")).toEqual([]);
    });
  });

  // ── Tier-gated cycles: CE can only validate the graceful degradation ──────
  //
  // GitLab CE 17.11 signals its REST feature gates as 404 (not 403), which the
  // cycles tolerate as "unmanaged/unset" without a NOTE; the GraphQL cycles hit
  // the missing-field gate, which does carry the tier NOTE. Either way the run
  // must not error and declared slices plan optimistically.

  applySuite("smoke: push-rules (Premium — tier-graceful on CE)", () => {
    it("tolerates the gated read and plans optimistically", async () => {
      const cr = one(
        await reconcile(
          "push-rules",
          { [PROJECT_PATH]: { kind: "project", pushRules: { commitMessageRegex: "^smoke" } } },
          "dry-run",
        ),
      );
      expect(cr.counts.create).toBe(1); // optimistic — CE returns 404 (unset/gated)
    });
  });

  applySuite("smoke: mr-approvals (Premium — tier-graceful on CE)", () => {
    it("tolerates the gated reads and plans optimistically", async () => {
      const cr = one(
        await reconcile(
          "mr-approvals",
          {
            [PROJECT_PATH]: {
              kind: "project",
              approvalRules: [{ name: "smoke-rule", approvalsRequired: 1 }],
              approvalSettings: { resetApprovalsOnPush: true },
            },
          },
          "dry-run",
        ),
      );
      expect(cr.counts.create).toBe(2);
    });
  });

  applySuite("smoke: protected-environments (Premium — tier-graceful on CE)", () => {
    it("tolerates the gated read; an optimistic apply lands in failed[], not a crash", async () => {
      const cr = one(
        await reconcile(
          "protected-environments",
          { [PROJECT_PATH]: { kind: "project", protectedEnvironments: [{ name: "production", deployAccessLevels: [40] }] } },
          "apply",
        ),
      );
      expect(cr.counts.create).toBe(1);
      expect(cr.failed).toHaveLength(1); // CE: POST returns 404 — recorded per entry
      expect(cr.failed[0]!.error).toContain("404");
    });
  });

  applySuite("smoke: member-roles (Ultimate — tier-graceful on CE)", () => {
    it("tolerates the gated read and plans optimistically", async () => {
      const cr = one(
        await reconcile(
          "member-roles",
          { [GROUP_PATH]: { kind: "group", memberRoles: [{ name: "smoke-role", baseAccessLevel: 30 }] } },
          "dry-run",
        ),
      );
      expect(cr.counts.create).toBe(1);
    });
  });

  applySuite("smoke: compliance-frameworks (Ultimate GraphQL — NOTE on CE)", () => {
    it("tolerates the missing EE field and flags the optimistic plan with a NOTE", async () => {
      const cr = one(
        await reconcile(
          "compliance-frameworks",
          { [GROUP_PATH]: { kind: "group", complianceFrameworks: [{ name: "smoke-framework" }] } },
          "dry-run",
        ),
      );
      expect(cr.counts.create).toBe(1);
      expect(cr.plan).toContain(
        "NOTE: complianceFrameworks: read was tier-gated (403); planned entries may fail on apply",
      );
    });
  });

  applySuite("smoke: security-policies (Ultimate GraphQL — NOTE on CE)", () => {
    it("tolerates the missing EE field and flags the optimistic plan with a NOTE", async () => {
      const cr = one(
        await reconcile(
          "security-policies",
          { [PROJECT_PATH]: { kind: "project", securityPolicy: { policyProject: `${GROUP_PATH}/policies` } } },
          "dry-run",
        ),
      );
      expect(cr.counts.create).toBe(1);
      expect(cr.plan).toContain(
        "NOTE: securityPolicy: read was tier-gated (403); planned entries may fail on apply",
      );
    });
  });

  // ── migrate: validate translated pipelines with GitLab's own CI lint ──────
  //
  // Migrates a realistic workflow set, commits the stitched output into the
  // throwaway project via the repository files API, then asks GitLab itself
  // (`POST /projects/:id/ci/lint`, project-scoped so `include: local:`
  // resolves against the committed files) whether the pipeline is valid.

  describe("migrate: translated pipelines pass GitLab CI lint", () => {
    interface LintResponse {
      valid: boolean;
      errors: string[];
      warnings: string[];
      merged_yaml: string | null;
    }

    const CI_WORKFLOW = [
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: make build",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    needs: build",
      "    strategy:",
      "      matrix:",
      "        node: [20, 22]",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: npm test",
      "",
    ].join("\n");

    const NIGHTLY_WORKFLOW = [
      "name: Nightly",
      "on:",
      "  schedule:",
      "    - cron: '0 6 * * 1'",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit",
      "",
    ].join("\n");

    async function lint(content: string): Promise<LintResponse> {
      return client.request<LintResponse>("POST", `/projects/${projectId}/ci/lint`, { content });
    }

    it("stitched directory output lints valid with includes resolved in project context", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "warden-e2e-migrate-"));
      try {
        const inDir = join(tmp, "workflows");
        const outDir = join(tmp, "out");
        mkdirSync(inDir, { recursive: true });
        writeFileSync(join(inDir, "ci.yml"), CI_WORKFLOW);
        writeFileSync(join(inDir, "nightly.yml"), NIGHTLY_WORKFLOW);

        const outcome = await runMigrate(parseMigrateArgs([inDir, "-o", outDir]));
        expect(outcome.exitCode).toBe(0);
        const rootFile = outcome.written.find((w) => basename(w) === ".gitlab-ci.yml");
        expect(rootFile).toBeDefined();
        expect(outcome.written.length).toBe(3); // 2 per-workflow files + stitched root

        // Commit the migrated set into the project so include:local resolves.
        await client.request("POST", `/projects/${projectId}/repository/commits`, {
          branch: "main",
          commit_message: "e2e: migrated pipeline set",
          actions: outcome.written.map((w) => ({
            action: "create",
            file_path: basename(w),
            content: readFileSync(w, "utf-8"),
          })),
        });

        const result = await lint(readFileSync(rootFile!, "utf-8"));
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);

        // The merged config carries every migrated job under the stage union.
        const merged = parseYaml(result.merged_yaml ?? "") as Record<string, unknown>;
        expect(merged["build"]).toBeDefined();
        expect(merged["test"]).toBeDefined();
        expect(merged["audit"]).toBeDefined();
        expect(merged["stages"]).toEqual(expect.arrayContaining(["build", "test"]));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }, 120_000);

    it("single-file (no-stitch) output lints valid", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "warden-e2e-migrate1-"));
      try {
        const src = join(tmp, "ci.yml");
        writeFileSync(src, CI_WORKFLOW);
        const outcome = await runMigrate(parseMigrateArgs([src]));
        expect(outcome.exitCode).toBe(0);

        const result = await lint(outcome.stdout);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        const merged = parseYaml(result.merged_yaml ?? "") as Record<string, unknown>;
        expect(merged["build"]).toBeDefined();
        expect(merged["test"]).toBeDefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
