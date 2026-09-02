import { describe, it, expect } from "vitest";
import { pipelineSchedulesCycle } from "./pipeline-schedules.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import { drainGatedSliceNotes } from "./_shared.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};
const PROJ = "project:acme/api";
const BASE = "/projects/acme%2Fapi/pipeline_schedules";

describe("pipelineSchedulesCycle.fetchLive", () => {
  it("lists schedules, then GETs each for its variables (the list omits them)", async () => {
    const client = makeClient(
      {
        [`GET ${BASE}/11`]: {
          id: 11,
          description: "nightly",
          cron: "0 2 * * *",
          cron_timezone: "UTC",
          ref: "refs/heads/main",
          active: true,
          variables: [{ key: "KIND", value: "nightly", variable_type: "env_var" }],
          owner: { username: "root" },
        },
      },
      { [BASE]: [{ id: 11, description: "nightly", cron: "0 2 * * *", ref: "refs/heads/main", active: true }] },
    );
    const live = await pipelineSchedulesCycle.fetchLive(client, PROJ, scope, makeBudget());
    expect(live.pipelineSchedules).toEqual([
      {
        id: 11,
        description: "nightly",
        cron: "0 2 * * *",
        cronTimezone: "UTC",
        ref: "main", // refs/heads/ prefix normalized for the diff
        active: true,
        variables: [{ key: "KIND", value: "nightly", variableType: "env_var" }],
        owner: "root",
      },
    ]);
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PAGINATE ${BASE}`, `GET ${BASE}/11`]);
  });

  it("tolerates a 403 read as unmanaged and records the plan NOTE", async () => {
    const client = makeClient();
    client.paginate = async () => {
      throw new Error("GitLab API 403 Forbidden");
    };
    const live = await pipelineSchedulesCycle.fetchLive(client, PROJ, scope, makeBudget());
    expect(live).toEqual({});
    expect(drainGatedSliceNotes()).toEqual([
      { cycle: "pipeline-schedules", scopeId: PROJ, slice: "pipelineSchedules" },
    ]);
  });
});

describe("pipelineSchedulesCycle.apply", () => {
  it("create POSTs the schedule, then POSTs each variable to the new id", async () => {
    const client = makeClient({ [`POST ${BASE}`]: { id: 42 } });
    await pipelineSchedulesCycle.apply(
      client,
      {
        kind: "create",
        resourceType: "pipeline-schedule",
        key: "nightly",
        after: {
          description: "nightly",
          cron: "0 2 * * *",
          cronTimezone: "UTC",
          ref: "main",
          active: true,
          variables: [{ key: "KIND", value: "nightly" }],
        },
      },
      PROJ,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: BASE,
      body: { description: "nightly", cron: "0 2 * * *", cron_timezone: "UTC", ref: "main", active: true },
    });
    expect(client.calls[1]).toMatchObject({
      method: "POST",
      path: `${BASE}/42/variables`,
      body: { key: "KIND", value: "nightly" },
    });
  });

  it("update PUTs schedule fields and reconciles variables by key (POST/PUT/DELETE)", async () => {
    const client = makeClient();
    await pipelineSchedulesCycle.apply(
      client,
      {
        kind: "update",
        resourceType: "pipeline-schedule",
        key: "nightly",
        before: {
          id: 11,
          description: "nightly",
          cron: "0 3 * * *",
          ref: "main",
          variables: [
            { key: "KEEP", value: "old" },
            { key: "STALE", value: "x" },
          ],
        },
        after: {
          description: "nightly",
          cron: "0 2 * * *",
          ref: "main",
          variables: [
            { key: "KEEP", value: "new" },
            { key: "ADDED", value: "y" },
          ],
        },
        fields: [
          { field: "cron", before: "0 3 * * *", after: "0 2 * * *" },
          { field: "variables", before: [], after: [] },
        ],
      },
      PROJ,
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT ${BASE}/11`,
      `PUT ${BASE}/11/variables/KEEP`,
      `POST ${BASE}/11/variables`,
      `DELETE ${BASE}/11/variables/STALE`,
    ]);
    expect(client.calls[0]!.body).toMatchObject({ cron: "0 2 * * *", ref: "main" });
    expect(client.calls[1]!.body).toMatchObject({ value: "new" });
  });

  it("a variables-only update skips the schedule PUT", async () => {
    const client = makeClient();
    await pipelineSchedulesCycle.apply(
      client,
      {
        kind: "update",
        resourceType: "pipeline-schedule",
        key: "nightly",
        before: { id: 11, description: "nightly", cron: "0 2 * * *", ref: "main", variables: [] },
        after: { description: "nightly", cron: "0 2 * * *", ref: "main", variables: [{ key: "K", value: "v" }] },
        fields: [{ field: "variables", before: [], after: [{ key: "K", value: "v" }] }],
      },
      PROJ,
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${BASE}/11/variables`]);
  });

  it("delete DELETEs by live id", async () => {
    const client = makeClient();
    await pipelineSchedulesCycle.apply(
      client,
      { kind: "delete", resourceType: "pipeline-schedule", key: "stale", before: { id: 7, description: "stale" } },
      PROJ,
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/7` });
  });

  it("a 403 on update surfaces the take_ownership caveat as a clear error", async () => {
    const client = makeClient({
      [`PUT ${BASE}/11`]: () => {
        throw new Error("GitLab API 403 Forbidden");
      },
    });
    await expect(
      pipelineSchedulesCycle.apply(
        client,
        {
          kind: "update",
          resourceType: "pipeline-schedule",
          key: "nightly",
          before: { id: 11, description: "nightly" },
          after: { description: "nightly", cron: "0 2 * * *", ref: "main" },
          fields: [{ field: "cron", before: "0 3 * * *", after: "0 2 * * *" }],
        },
        PROJ,
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow(/take ownership first \(POST .*\/11\/take_ownership\)/);
  });
});

describe("pipelineSchedulesCycle via runReconcile", () => {
  it("no-ops on group nodes (kind guard)", async () => {
    const client = makeClient();
    const live = await pipelineSchedulesCycle.fetchLive(client, "group:acme", scope, makeBudget());
    expect(live).toEqual({});
    expect(client.calls).toEqual([]);
    const desired = pipelineSchedulesCycle.buildDesired(
      { kind: "group", pipelineSchedules: [{ description: "d", cron: "0 2 * * *", ref: "main" }] },
      "group:acme",
      scope,
    );
    expect(desired.pipelineSchedules).toBeUndefined();
  });

  it("corrects cron drift end-to-end", async () => {
    const config: GovernanceConfig = {
      nodes: {
        "acme/api": {
          kind: "project",
          pipelineSchedules: [{ description: "nightly", cron: "0 2 * * *", ref: "main" }],
        },
      },
    };
    const client = makeClient(
      { [`GET ${BASE}/11`]: { id: 11, description: "nightly", cron: "0 5 * * *", ref: "main" } },
      { [BASE]: [{ id: 11, description: "nightly", cron: "0 5 * * *", ref: "main" }] },
    );
    const result = await runReconcile({ config, client, cycles: [pipelineSchedulesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PUT")).toMatchObject({
      path: `${BASE}/11`,
      body: { cron: "0 2 * * *" },
    });
  });

  it("deletes an undeclared schedule only under `owned`, counted by the removal cap", async () => {
    const pages = {
      [BASE]: [
        { id: 1, description: "keep", cron: "0 1 * * *", ref: "main" },
        { id: 2, description: "stale", cron: "0 2 * * *", ref: "main" },
        { id: 3, description: "keep2", cron: "0 3 * * *", ref: "main" },
        { id: 4, description: "keep3", cron: "0 4 * * *", ref: "main" },
      ],
    };
    const responses = Object.fromEntries(
      pages[BASE]!.map((s) => [`GET ${BASE}/${s.id}`, s]),
    );
    const declared = ["keep", "keep2", "keep3"].map((d, i) => ({
      description: d,
      cron: `0 ${[1, 3, 4][i]} * * *`,
      ref: "main",
    }));
    // Not owned → no delete planned.
    const unowned = await runReconcile({
      config: { nodes: { "acme/api": { kind: "project", pipelineSchedules: declared } } },
      client: makeClient(responses, pages),
      cycles: [pipelineSchedulesCycle],
      mode: "apply",
    });
    expect(unowned.cycles[0]!.counts.delete).toBe(0);

    // Owned → 1 delete of 4 live (25%) passes the cap and applies.
    const client = makeClient(responses, pages);
    const owned = await runReconcile({
      config: { nodes: { "acme/api": { kind: "project", owned: ["pipeline-schedule"], pipelineSchedules: declared } } },
      client,
      cycles: [pipelineSchedulesCycle],
      mode: "apply",
    });
    expect(owned.cycles[0]!.counts.delete).toBe(1);
    expect(owned.cycles[0]!.guardrailBlocked).toBe(false);
    expect(client.calls.find((c) => c.method === "DELETE")!.path).toBe(`${BASE}/2`);

    // Deleting 2 of 4 live (50% > 25%) trips removalDeltaCap.
    const blocked = await runReconcile({
      config: {
        nodes: {
          "acme/api": { kind: "project", owned: ["pipeline-schedule"], pipelineSchedules: declared.slice(0, 2) },
        },
      },
      client: makeClient(responses, pages),
      cycles: [pipelineSchedulesCycle],
      mode: "apply",
    });
    expect(blocked.cycles[0]!.guardrailBlocked).toBe(true);
  });
});
