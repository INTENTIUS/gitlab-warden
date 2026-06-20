/**
 * MR-approvals cycle — project approval rules + approval settings.
 *
 *   fetchLive — GET /projects/:id/approval_rules (rules) + /approvals (settings)
 *   apply
 *     approval-rule     → POST / PUT / DELETE /projects/:id/approval_rules[/:id]
 *     approval-settings → POST /projects/:id/approvals (single config)
 *
 * Project-scoped (group approval rules are experimental/flag-gated — skipped).
 * Premium/Ultimate-gated — 403 on read is tolerated (slice unmanaged).
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, ApprovalRuleConfig, ApprovalSettings } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveApprovalRule, LiveApprovalSettings } from "../reconcile/live.js";
import { charge, isForbidden, isNotFound } from "./_shared.js";

export type MrApprovalsScope = Record<string, never>;

interface GlRule {
  id?: number;
  name?: string;
  approvals_required?: number;
  users?: Array<{ id?: number }>;
  groups?: Array<{ id?: number }>;
  protected_branches?: Array<{ id?: number }>;
}
interface GlSettings {
  reset_approvals_on_push?: boolean;
  disable_overriding_approvers_per_merge_request?: boolean;
  merge_requests_author_approval?: boolean;
  merge_requests_disable_committers_approval?: boolean;
  require_password_to_approve?: boolean;
}

function ids(arr?: Array<{ id?: number }>): number[] | undefined {
  if (!arr) return undefined;
  return arr.map((x) => x.id).filter((n): n is number => typeof n === "number");
}

function mapRule(raw: GlRule): LiveApprovalRule {
  const r: LiveApprovalRule = { name: raw.name ?? "" };
  if (typeof raw.id === "number") r.id = raw.id;
  if (typeof raw.approvals_required === "number") r.approvalsRequired = raw.approvals_required;
  const u = ids(raw.users), g = ids(raw.groups), p = ids(raw.protected_branches);
  if (u) r.userIds = u;
  if (g) r.groupIds = g;
  if (p) r.protectedBranchIds = p;
  return r;
}

function mapSettings(raw: GlSettings): LiveApprovalSettings {
  const s: LiveApprovalSettings = {};
  if (typeof raw.reset_approvals_on_push === "boolean") s.resetApprovalsOnPush = raw.reset_approvals_on_push;
  if (typeof raw.disable_overriding_approvers_per_merge_request === "boolean") s.disableOverridingApproversPerMergeRequest = raw.disable_overriding_approvers_per_merge_request;
  if (typeof raw.merge_requests_author_approval === "boolean") s.mergeRequestsAuthorApproval = raw.merge_requests_author_approval;
  if (typeof raw.merge_requests_disable_committers_approval === "boolean") s.mergeRequestsDisableCommittersApproval = raw.merge_requests_disable_committers_approval;
  if (typeof raw.require_password_to_approve === "boolean") s.requirePasswordToApprove = raw.require_password_to_approve;
  return s;
}

export function buildRuleBody(d: ApprovalRuleConfig, includeName: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (includeName) body.name = d.name;
  if (d.approvalsRequired !== undefined) body.approvals_required = d.approvalsRequired;
  if (d.userIds !== undefined) body.user_ids = d.userIds;
  if (d.groupIds !== undefined) body.group_ids = d.groupIds;
  if (d.protectedBranchIds !== undefined) body.protected_branch_ids = d.protectedBranchIds;
  return body;
}

export function buildSettingsBody(d: ApprovalSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (d.resetApprovalsOnPush !== undefined) body.reset_approvals_on_push = d.resetApprovalsOnPush;
  if (d.disableOverridingApproversPerMergeRequest !== undefined) body.disable_overriding_approvers_per_merge_request = d.disableOverridingApproversPerMergeRequest;
  if (d.mergeRequestsAuthorApproval !== undefined) body.merge_requests_author_approval = d.mergeRequestsAuthorApproval;
  if (d.mergeRequestsDisableCommittersApproval !== undefined) body.merge_requests_disable_committers_approval = d.mergeRequestsDisableCommittersApproval;
  if (d.requirePasswordToApprove !== undefined) body.require_password_to_approve = d.requirePasswordToApprove;
  return body;
}

export const mrApprovalsCycle: Cycle<MrApprovalsScope> = {
  name: "mr-approvals",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: MrApprovalsScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    if (kind !== "project") return {};
    const id = encodeId(path);
    const out: LiveNodeState = {};
    try {
      charge(budget);
      const rules = await client.paginate<GlRule>(`/projects/${id}/approval_rules`);
      out.approvalRules = rules.filter((r) => r.name).map(mapRule);
    } catch (err) {
      if (!isForbidden(err)) throw err;
    }
    try {
      charge(budget);
      const s = await client.request<GlSettings>("GET", `/projects/${id}/approvals`);
      out.approvalSettings = mapSettings(s);
    } catch (err) {
      if (!isForbidden(err) && !isNotFound(err)) throw err;
    }
    return out;
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (config.kind !== "project") return { kind: config.kind };
    const out: NodeConfig = { kind: "project" };
    if (config.approvalRules !== undefined) out.approvalRules = config.approvalRules;
    if (config.approvalSettings !== undefined) out.approvalSettings = config.approvalSettings;
    return out;
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: MrApprovalsScope,
    budget: RateBudget,
  ): Promise<void> {
    const { path } = parseScope(scopeId);
    const id = encodeId(path);

    if (entry.resourceType === "approval-settings") {
      charge(budget);
      await client.request("POST", `/projects/${id}/approvals`, buildSettingsBody(entry.after as ApprovalSettings));
      return;
    }
    if (entry.resourceType !== "approval-rule") return;
    const base = `/projects/${id}/approval_rules`;
    if (entry.kind === "create") {
      charge(budget);
      await client.request("POST", base, buildRuleBody(entry.after as ApprovalRuleConfig, true));
      return;
    }
    const ruleId = (entry.before as LiveApprovalRule | undefined)?.id;
    if (typeof ruleId !== "number") throw new Error(`approval rule '${entry.key}' has no live id`);
    if (entry.kind === "update") {
      charge(budget);
      await client.request("PUT", `${base}/${ruleId}`, buildRuleBody(entry.after as ApprovalRuleConfig, false));
      return;
    }
    charge(budget);
    await client.request("DELETE", `${base}/${ruleId}`);
  },
};
