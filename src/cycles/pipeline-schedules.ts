/**
 * Pipeline-schedules cycle — project pipeline schedules, keyed by description.
 *
 *   fetchLive — GET /projects/:id/pipeline_schedules (paginated), then
 *               GET /projects/:id/pipeline_schedules/:sid per schedule for its
 *               variables (the list endpoint omits them)
 *   apply
 *     create → POST /projects/:id/pipeline_schedules, then POST .../:sid/variables
 *     update → PUT /projects/:id/pipeline_schedules/:sid for cron/cronTimezone/
 *              ref/active; variables reconciled by key via POST/PUT/DELETE
 *              .../variables/:key
 *     delete → DELETE /projects/:id/pipeline_schedules/:sid
 *
 * Project nodes only (group/instance kinds no-op). GitLab gives schedules no
 * natural key, so `description` is the identity — renaming one is a
 * delete + create. A schedule is owned by the user who created it, and GitLab
 * refuses writes to another user's schedule with a 403: warden surfaces that
 * as a clear apply error naming the `take_ownership` endpoint rather than a
 * bare status code. The API is free-tier, but reads run the standard
 * 403-tolerance + plan NOTE anyway.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type {
  NodeConfig,
  PipelineScheduleConfig,
  PipelineScheduleVariableConfig,
} from "../config/types.js";
import { scheduleVarNeedsWrite, shortRef } from "../reconcile/diff.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type {
  LiveNodeState,
  LivePipelineSchedule,
  LivePipelineScheduleVariable,
} from "../reconcile/live.js";
import { charge, isForbidden, noteGatedSlice, notePlan } from "./_shared.js";

export type PipelineSchedulesScope = Record<string, never>;

interface GlScheduleVariable {
  key?: string;
  value?: string;
  variable_type?: string;
}

interface GlSchedule {
  id?: number;
  description?: string;
  cron?: string;
  cron_timezone?: string;
  ref?: string;
  active?: boolean;
  variables?: GlScheduleVariable[];
  owner?: { username?: string };
}

function mapVariable(raw: GlScheduleVariable): LivePipelineScheduleVariable {
  const v: LivePipelineScheduleVariable = { key: raw.key ?? "" };
  if (raw.value !== undefined) v.value = raw.value;
  if (raw.variable_type !== undefined) v.variableType = raw.variable_type;
  return v;
}

function mapSchedule(raw: GlSchedule): LivePipelineSchedule {
  const s: LivePipelineSchedule = { description: raw.description ?? "" };
  if (typeof raw.id === "number") s.id = raw.id;
  if (raw.cron !== undefined) s.cron = raw.cron;
  if (raw.cron_timezone !== undefined) s.cronTimezone = raw.cron_timezone;
  // GitLab may report the ref fully qualified ("refs/heads/main"); normalize
  // for the diff (which normalizes the desired side symmetrically).
  if (raw.ref !== undefined) s.ref = shortRef(raw.ref);
  if (typeof raw.active === "boolean") s.active = raw.active;
  if (raw.variables !== undefined) s.variables = raw.variables.filter((v) => v.key).map(mapVariable);
  if (raw.owner?.username !== undefined) s.owner = raw.owner.username;
  return s;
}

function scheduleBody(d: PipelineScheduleConfig, includeKey: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (includeKey) body.description = d.description;
  body.cron = d.cron;
  body.ref = d.ref;
  if (d.cronTimezone !== undefined) body.cron_timezone = d.cronTimezone;
  if (d.active !== undefined) body.active = d.active;
  return body;
}

function variableBody(v: PipelineScheduleVariableConfig): Record<string, unknown> {
  const body: Record<string, unknown> = { key: v.key, value: v.value };
  if (v.variableType !== undefined) body.variable_type = v.variableType;
  return body;
}

/**
 * Re-throw a 403 from a schedule write as the ownership caveat: GitLab lets
 * only a schedule's owner update or delete it, and warden's token may not own
 * a schedule created by another user (or by hand in the UI).
 */
function rethrowOwnership(err: unknown, key: string, base: string, sid: number): never {
  if (isForbidden(err)) {
    throw new Error(
      `pipeline schedule '${key}': GitLab refused the write (403) — schedules can only be ` +
        `modified by their owner. If another user created it, take ownership first ` +
        `(POST ${base}/${sid}/take_ownership) and re-run. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw err;
}

/**
 * Reconcile a schedule's variables by key (POST new, PUT changed, DELETE
 * absent from `desired`). `desired` is the diff's ownership-aware target list
 * (`after.variables`): on an unowned schedule it carries the live extras
 * along, so the delete loop never prunes an undeclared variable without
 * ownership. Drift per variable is the shared `scheduleVarNeedsWrite` rule.
 */
async function applyVariables(
  client: GitLabClient,
  base: string,
  sid: number,
  desired: PipelineScheduleVariableConfig[],
  live: LivePipelineScheduleVariable[],
  budget: RateBudget,
): Promise<void> {
  const have = new Map(live.map((v) => [v.key, v]));
  for (const d of desired) {
    const l = have.get(d.key);
    if (!scheduleVarNeedsWrite(d, l)) continue;
    charge(budget);
    if (!l) {
      await client.request("POST", `${base}/${sid}/variables`, variableBody(d));
    } else {
      const body: Record<string, unknown> = { value: d.value };
      if (d.variableType !== undefined) body.variable_type = d.variableType;
      await client.request("PUT", `${base}/${sid}/variables/${encodeId(d.key)}`, body);
    }
  }
  const want = new Set(desired.map((v) => v.key));
  for (const l of live) {
    if (!want.has(l.key)) {
      charge(budget);
      await client.request("DELETE", `${base}/${sid}/variables/${encodeId(l.key)}`);
    }
  }
}

/**
 * GitLab gives schedules no unique-description constraint, but the diff keys
 * live schedules by description, so duplicates shadow each other: only the
 * last-listed one is reconciled and the rest silently disappear from the
 * plan. Surface a plan NOTE naming the shadowed schedule ids instead.
 */
function noteShadowedDuplicates(schedules: LivePipelineSchedule[], scopeId: string): void {
  const byDesc = new Map<string, LivePipelineSchedule[]>();
  for (const s of schedules) {
    const group = byDesc.get(s.description);
    if (group) group.push(s);
    else byDesc.set(s.description, [s]);
  }
  for (const [desc, group] of byDesc) {
    if (group.length < 2) continue;
    const visible = group[group.length - 1]!.id;
    const shadowed = group.slice(0, -1).map((s) => s.id ?? "?");
    notePlan(
      "pipeline-schedules",
      scopeId,
      `pipelineSchedules: ${group.length} live schedules share description "${desc}" — ` +
        `only id ${visible} is reconciled; id(s) ${shadowed.join(", ")} are shadowed. ` +
        `Give every schedule a unique description.`,
    );
  }
}

export const pipelineSchedulesCycle: Cycle<PipelineSchedulesScope> = {
  name: "pipeline-schedules",
  verb: "org-unit",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: PipelineSchedulesScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "project") return {};
    const base = `/projects/${encodeId(path)}/pipeline_schedules`;
    try {
      charge(budget);
      const listed = (await client.paginate<GlSchedule>(base)).filter(
        (raw) => raw.description && typeof raw.id === "number",
      );
      // The list endpoint omits variables — fetch each schedule's detail, the
      // sole source of truth for its live state. The GETs are charged up
      // front, then run with bounded concurrency; results keep list order.
      if (listed.length > 0) charge(budget, listed.length);
      const details = new Array<GlSchedule>(listed.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(5, listed.length) }, async () => {
          for (let i = next++; i < listed.length; i = next++) {
            details[i] = await client.request<GlSchedule>("GET", `${base}/${listed[i]!.id}`);
          }
        }),
      );
      const schedules = details.map(mapSchedule);
      noteShadowedDuplicates(schedules, scopeId);
      return { pipelineSchedules: schedules };
    } catch (err) {
      if (!isForbidden(err)) throw err;
      noteGatedSlice("pipeline-schedules", scopeId, "pipelineSchedules");
      return {};
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "project" || !config.pipelineSchedules) return { kind: config.kind };
    return { kind: "project", pipelineSchedules: config.pipelineSchedules };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: PipelineSchedulesScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "pipeline-schedule") return;
    const { path } = parseScope(scopeId);
    const base = `/projects/${encodeId(path)}/pipeline_schedules`;

    if (entry.kind === "create") {
      const after = entry.after as PipelineScheduleConfig;
      charge(budget);
      const created = await client.request<GlSchedule>("POST", base, scheduleBody(after, true));
      const sid = created.id;
      if (after.variables && after.variables.length > 0) {
        if (typeof sid !== "number") {
          throw new Error(`pipeline schedule '${entry.key}': create response carried no id for its variables`);
        }
        for (const v of after.variables) {
          charge(budget);
          await client.request("POST", `${base}/${sid}/variables`, variableBody(v));
        }
      }
      return;
    }

    const sid = (entry.before as LivePipelineSchedule | undefined)?.id;
    if (typeof sid !== "number") throw new Error(`pipeline schedule '${entry.key}' has no live id`);

    if (entry.kind === "delete") {
      charge(budget);
      try {
        await client.request("DELETE", `${base}/${sid}`);
      } catch (err) {
        rethrowOwnership(err, entry.key, base, sid);
      }
      return;
    }

    // update
    const after = entry.after as PipelineScheduleConfig;
    const before = entry.before as LivePipelineSchedule;
    const changedVarsOnly =
      entry.fields !== undefined &&
      entry.fields.length > 0 &&
      entry.fields.every((f) => f.field === "variables");
    try {
      if (!changedVarsOnly) {
        charge(budget);
        await client.request("PUT", `${base}/${sid}`, scheduleBody(after, false));
      }
      if (after.variables !== undefined && entry.fields?.some((f) => f.field === "variables")) {
        await applyVariables(client, base, sid, after.variables, before.variables ?? [], budget);
      }
    } catch (err) {
      rethrowOwnership(err, entry.key, base, sid);
    }
  },
};
