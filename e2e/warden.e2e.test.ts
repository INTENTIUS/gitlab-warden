/**
 * Hermetic end-to-end harness — exercises every registered cycle against a REAL
 * GitLab instance (a throwaway Docker Compose GitLab CE stack — see
 * e2e/docker-compose.yml + e2e/bootstrap.sh). Gated and excluded from the
 * default test run; run with `npm run test:e2e:run`.
 *
 * ## Gating
 * Skips entirely unless GITLAB_E2E_URL and GITLAB_E2E_TOKEN are set.
 *
 * ## Coverage note
 * GitLab CE lacks Premium/Ultimate features (push rules, approvals, compliance,
 * security policies, …). The cycles tolerate 403/absent and return empty, so
 * Phase 1 exercises every cycle's read path and asserts it's read-only —
 * tolerating per-cycle errors on features CE can't provide. The Ultimate-only
 * GraphQL cycles (compliance, security-policies) can't be validated here.
 *
 * ## Phases
 *   1 (always): per cycle × {group, project} node, fetchLive + diff; assert
 *     every call was read-only (no POST/PUT/PATCH/DELETE).
 *   2 (GITLAB_E2E_APPLY=1): group-settings apply (description), verified by re-fetch.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createClient, encodeId, type GitLabClient } from "../src/auth/client.js";
import { CYCLE_REGISTRY } from "../src/cli/registry.js";
import { groupSettingsCycle } from "../src/cycles/group-settings.js";
import { diff } from "../src/reconcile/diff.js";
import { nodeScopeId, type RateBudget } from "../src/reconcile/runner.js";
import type { NodeConfig } from "../src/config/types.js";

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

const GROUP_PATH = `warden-e2e-${ENV.GITHUB_RUN_ID ?? Date.now()}`.toLowerCase();
const PROJECT_NAME = "probe";
const PROJECT_PATH = `${GROUP_PATH}/${PROJECT_NAME}`;

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
  }, 90_000);

  afterAll(async () => {
    if (projectId !== undefined) await client.request("DELETE", `/projects/${projectId}`).catch(() => {});
    if (groupId !== undefined) await client.request("DELETE", `/groups/${groupId}`).catch(() => {});
  }, 60_000);

  // ── Phase 1: every cycle's read path is read-only on both node kinds ──────
  const nodes = [
    { id: nodeScopeId("group", GROUP_PATH), cfg: (): NodeConfig => ({ kind: "group", groupSettings: { description: "x" } }) },
    { id: nodeScopeId("project", PROJECT_PATH), cfg: (): NodeConfig => ({ kind: "project", projectSettings: { description: "x" } }) },
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
      }, 60_000);
    }
  }

  // ── Phase 2: one real apply (opt-in) ──────────────────────────────────────
  (APPLY ? it : it.skip)(
    "apply: group-settings sets the description, verified by re-fetch",
    async () => {
      const node = nodeScopeId("group", GROUP_PATH);
      await groupSettingsCycle.apply(
        client,
        { kind: "update", resourceType: "group-settings", key: "group-settings", after: { description: "warden e2e applied" } },
        node,
        {},
        makeBudget(),
      );
      const got = await client.request<{ description?: string }>("GET", `/groups/${encodeId(GROUP_PATH)}`);
      expect(got.description).toBe("warden e2e applied");
    },
    60_000,
  );
});
