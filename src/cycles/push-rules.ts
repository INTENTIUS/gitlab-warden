/**
 * Push-rules cycle — THE FLAGSHIP.
 *
 * GitLab push rules aren't version-controlled and their inheritance is broken:
 * they're copied at project creation and never propagate, so changing a group
 * rule never reaches existing projects. This cycle re-asserts declared push
 * rules across every declared node, continuously — fixing the drift that neither
 * native GitLab nor a one-shot apply addresses.
 *
 * Both project and group expose the same sub-resource:
 *   fetchLive — GET    /{groups|projects}/:id/push_rule  (404/403 → unmanaged)
 *   apply
 *     create → POST   …/push_rule   (no rule set yet)
 *     update → PUT    …/push_rule   (drift → re-assert)
 *     delete → DELETE …/push_rule
 *
 * Premium/Ultimate-gated — a 403 on read is tolerated (the slice is simply not
 * reconciled); a 403 on apply surfaces in failed[] with the API message.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, PushRulesConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LivePushRules } from "../reconcile/live.js";
import { charge, isNotFound, isForbidden } from "./_shared.js";

export type PushRulesScope = Record<string, never>;

interface GlPushRule {
  commit_message_regex?: string | null;
  commit_message_negative_regex?: string | null;
  branch_name_regex?: string | null;
  author_email_regex?: string | null;
  file_name_regex?: string | null;
  max_file_size?: number | null;
  prevent_secrets?: boolean | null;
  member_check?: boolean | null;
  reject_unsigned_commits?: boolean | null;
  reject_non_dco_commits?: boolean | null;
}

function mapPushRule(raw: GlPushRule): LivePushRules {
  const r: LivePushRules = {};
  if (raw.commit_message_regex != null) r.commitMessageRegex = raw.commit_message_regex;
  if (raw.commit_message_negative_regex != null) r.commitMessageNegativeRegex = raw.commit_message_negative_regex;
  if (raw.branch_name_regex != null) r.branchNameRegex = raw.branch_name_regex;
  if (raw.author_email_regex != null) r.authorEmailRegex = raw.author_email_regex;
  if (raw.file_name_regex != null) r.fileNameRegex = raw.file_name_regex;
  if (typeof raw.max_file_size === "number") r.maxFileSize = raw.max_file_size;
  if (typeof raw.prevent_secrets === "boolean") r.preventSecrets = raw.prevent_secrets;
  if (typeof raw.member_check === "boolean") r.memberCheck = raw.member_check;
  if (typeof raw.reject_unsigned_commits === "boolean") r.rejectUnsignedCommits = raw.reject_unsigned_commits;
  if (typeof raw.reject_non_dco_commits === "boolean") r.rejectNonDcoCommits = raw.reject_non_dco_commits;
  return r;
}

/** Build the `/push_rule` body (camelCase → GitLab snake_case). */
export function buildPushRuleBody(d: PushRulesConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (d.commitMessageRegex !== undefined) body.commit_message_regex = d.commitMessageRegex;
  if (d.commitMessageNegativeRegex !== undefined) body.commit_message_negative_regex = d.commitMessageNegativeRegex;
  if (d.branchNameRegex !== undefined) body.branch_name_regex = d.branchNameRegex;
  if (d.authorEmailRegex !== undefined) body.author_email_regex = d.authorEmailRegex;
  if (d.fileNameRegex !== undefined) body.file_name_regex = d.fileNameRegex;
  if (d.maxFileSize !== undefined) body.max_file_size = d.maxFileSize;
  if (d.preventSecrets !== undefined) body.prevent_secrets = d.preventSecrets;
  if (d.memberCheck !== undefined) body.member_check = d.memberCheck;
  if (d.rejectUnsignedCommits !== undefined) body.reject_unsigned_commits = d.rejectUnsignedCommits;
  if (d.rejectNonDcoCommits !== undefined) body.reject_non_dco_commits = d.rejectNonDcoCommits;
  return body;
}

function resourceFor(scopeId: string): { base: string } {
  const { kind, path } = parseScope(scopeId);
  const resource = kind === "group" ? "groups" : "projects";
  return { base: `/${resource}/${encodeId(path)}/push_rule` };
}

export const pushRulesCycle: Cycle<PushRulesScope> = {
  name: "push-rules",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: PushRulesScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { base } = resourceFor(scopeId);
    charge(budget);
    try {
      const raw = await client.request<GlPushRule | null>("GET", base);
      // GitLab returns null/empty when no push rule is set.
      if (!raw || Object.keys(raw).length === 0) return {};
      return { pushRules: mapPushRule(raw) };
    } catch (err) {
      if (isNotFound(err) || isForbidden(err)) return {}; // unset, or Premium-gated → unmanaged
      throw err;
    }
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (!config.pushRules) return { kind: config.kind };
    return { kind: config.kind, pushRules: config.pushRules };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: PushRulesScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "push-rules") return;
    const { base } = resourceFor(scopeId);
    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", base);
      return;
    }
    const body = buildPushRuleBody(entry.after as PushRulesConfig);
    if (Object.keys(body).length === 0) return;
    charge(budget);
    // POST when no rule exists yet (create), PUT to re-assert drift (update).
    await client.request(entry.kind === "create" ? "POST" : "PUT", base, body);
  },
};
