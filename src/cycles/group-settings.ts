/**
 * Group-settings cycle — the template cycle.
 *
 * Reconciles group-level settings on group nodes. Every later cycle follows this
 * four-part shape:
 *   1. config slice   — `groupSettings` (config/types.ts)
 *   2. fetchLive      — GET /groups/:id  → LiveGroupSettings (group nodes only)
 *   3. buildDesired   — config → minimal NodeConfig
 *   4. apply          — PUT /groups/:id with declared fields (partial update)
 *
 * The scope id is kind-prefixed (`group:acme/platform`); this cycle is a no-op
 * on project nodes. `PUT /groups/:id` is a partial update, so selective-by-
 * omission holds by sending only declared keys — no read-modify-write.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, GroupSettings } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveGroupSettings } from "../reconcile/live.js";
import { charge, isNotFound } from "./_shared.js";

export type GroupSettingsScope = Record<string, never>;

/** Minimal shape of the `GET /groups/:id` response we read. */
interface GlGroup {
  name?: string | null;
  description?: string | null;
  visibility?: string | null;
  request_access_enabled?: boolean | null;
  project_creation_level?: string | null;
  subgroup_creation_level?: string | null;
  prevent_forking_outside_group?: boolean | null;
  mentions_disabled?: boolean | null;
}

const VISIBILITY = new Set(["private", "internal", "public"]);

function mapGroupToLive(raw: GlGroup): LiveGroupSettings {
  const live: LiveGroupSettings = {};
  if (raw.name != null) live.name = raw.name;
  if (raw.description != null) live.description = raw.description;
  if (raw.visibility != null && VISIBILITY.has(raw.visibility)) {
    live.visibility = raw.visibility as LiveGroupSettings["visibility"];
  }
  if (typeof raw.request_access_enabled === "boolean") live.requestAccessEnabled = raw.request_access_enabled;
  if (raw.project_creation_level != null) live.projectCreationLevel = raw.project_creation_level;
  if (raw.subgroup_creation_level != null) live.subgroupCreationLevel = raw.subgroup_creation_level;
  if (typeof raw.prevent_forking_outside_group === "boolean") live.preventForkingOutsideGroup = raw.prevent_forking_outside_group;
  if (typeof raw.mentions_disabled === "boolean") live.mentionsDisabled = raw.mentions_disabled;
  return live;
}

/** Build the partial `PUT /groups/:id` body (camelCase → GitLab snake_case). */
export function buildGroupBody(d: GroupSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (d.name !== undefined) body.name = d.name;
  if (d.description !== undefined) body.description = d.description;
  if (d.visibility !== undefined) body.visibility = d.visibility;
  if (d.requestAccessEnabled !== undefined) body.request_access_enabled = d.requestAccessEnabled;
  if (d.projectCreationLevel !== undefined) body.project_creation_level = d.projectCreationLevel;
  if (d.subgroupCreationLevel !== undefined) body.subgroup_creation_level = d.subgroupCreationLevel;
  if (d.preventForkingOutsideGroup !== undefined) body.prevent_forking_outside_group = d.preventForkingOutsideGroup;
  if (d.mentionsDisabled !== undefined) body.mentions_disabled = d.mentionsDisabled;
  return body;
}

export const groupSettingsCycle: Cycle<GroupSettingsScope> = {
  name: "group-settings",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: GroupSettingsScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "group") return {};
    charge(budget);
    try {
      const raw = await client.request<GlGroup>("GET", `/groups/${encodeId(path)}`);
      return { groupSettings: mapGroupToLive(raw) };
    } catch (err) {
      if (isNotFound(err)) return {};
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "group" || !config.groupSettings) return { kind: config.kind };
    return { kind: "group", groupSettings: config.groupSettings };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: GroupSettingsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "group-settings") return;
    const { path } = parseScope(scopeId);
    const body = buildGroupBody(entry.after as GroupSettings);
    if (Object.keys(body).length === 0) return;
    charge(budget);
    await client.request("PUT", `/groups/${encodeId(path)}`, body);
  },
};
