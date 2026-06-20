/**
 * Project-settings cycle — reconciles settings on project nodes.
 *
 *   fetchLive    — GET /projects/:id  → LiveProjectSettings (+ topics)
 *   buildDesired — config.projectSettings (project nodes only)
 *   apply        — partial PUT /projects/:id (settings + topics inline)
 *
 * No-op on group nodes. `PUT /projects/:id` is a partial update and accepts
 * `topics` directly, so a single declared-fields PUT suffices (no RMW).
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, ProjectSettings } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveProjectSettings } from "../reconcile/live.js";
import { charge, isNotFound } from "./_shared.js";

export type ProjectSettingsScope = Record<string, never>;

interface GlProject {
  description?: string | null;
  visibility?: string | null;
  default_branch?: string | null;
  merge_method?: string | null;
  squash_option?: string | null;
  only_allow_merge_if_pipeline_succeeds?: boolean | null;
  only_allow_merge_if_all_discussions_are_resolved?: boolean | null;
  remove_source_branch_after_merge?: boolean | null;
  topics?: string[] | null;
}

const VISIBILITY = new Set(["private", "internal", "public"]);

function mapProjectToLive(raw: GlProject): LiveProjectSettings {
  const r: LiveProjectSettings = {};
  if (raw.description != null) r.description = raw.description;
  if (raw.visibility != null && VISIBILITY.has(raw.visibility)) r.visibility = raw.visibility as LiveProjectSettings["visibility"];
  if (raw.default_branch != null) r.defaultBranch = raw.default_branch;
  if (raw.merge_method != null) r.mergeMethod = raw.merge_method;
  if (raw.squash_option != null) r.squashOption = raw.squash_option;
  if (typeof raw.only_allow_merge_if_pipeline_succeeds === "boolean") r.onlyAllowMergeIfPipelineSucceeds = raw.only_allow_merge_if_pipeline_succeeds;
  if (typeof raw.only_allow_merge_if_all_discussions_are_resolved === "boolean") r.onlyAllowMergeIfAllDiscussionsAreResolved = raw.only_allow_merge_if_all_discussions_are_resolved;
  if (typeof raw.remove_source_branch_after_merge === "boolean") r.removeSourceBranchAfterMerge = raw.remove_source_branch_after_merge;
  if (Array.isArray(raw.topics)) r.topics = raw.topics;
  return r;
}

/** Build the partial `PUT /projects/:id` body (topics included inline). */
export function buildProjectBody(d: ProjectSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (d.description !== undefined) body.description = d.description;
  if (d.visibility !== undefined) body.visibility = d.visibility;
  if (d.defaultBranch !== undefined) body.default_branch = d.defaultBranch;
  if (d.mergeMethod !== undefined) body.merge_method = d.mergeMethod;
  if (d.squashOption !== undefined) body.squash_option = d.squashOption;
  if (d.onlyAllowMergeIfPipelineSucceeds !== undefined) body.only_allow_merge_if_pipeline_succeeds = d.onlyAllowMergeIfPipelineSucceeds;
  if (d.onlyAllowMergeIfAllDiscussionsAreResolved !== undefined) body.only_allow_merge_if_all_discussions_are_resolved = d.onlyAllowMergeIfAllDiscussionsAreResolved;
  if (d.removeSourceBranchAfterMerge !== undefined) body.remove_source_branch_after_merge = d.removeSourceBranchAfterMerge;
  if (d.topics !== undefined) body.topics = d.topics;
  return body;
}

export const projectSettingsCycle: Cycle<ProjectSettingsScope> = {
  name: "project-settings",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: ProjectSettingsScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "project") return {};
    charge(budget);
    try {
      const raw = await client.request<GlProject>("GET", `/projects/${encodeId(path)}`);
      return { projectSettings: mapProjectToLive(raw) };
    } catch (err) {
      if (isNotFound(err)) return {};
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "project" || !config.projectSettings) return { kind: config.kind };
    return { kind: "project", projectSettings: config.projectSettings };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: ProjectSettingsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "project-settings") return;
    const { path } = parseScope(scopeId);
    const body = buildProjectBody(entry.after as ProjectSettings);
    if (Object.keys(body).length === 0) return;
    charge(budget);
    await client.request("PUT", `/projects/${encodeId(path)}`, body);
  },
};
