/**
 * GitLab plan/diff.
 *
 * Composes the shared `diffCollection` / `diffFields` primitives from
 * `@intentius/chant/reconcile` over GitLab's resource types into a `ChangeSet`.
 * The diff machinery is imported, not vendored.
 *
 * Selective-by-omission (a field/collection absent from desired is never
 * diffed) and ownership-gated deletes (`opts.isOwned`).
 *
 * Members are diffed against the **direct** roster only (fetchLive returns
 * direct members) — so an inherited member, never present in `live`, can never
 * produce a delete entry (see DESIGN.md §2).
 */

import {
  diffCollection,
  diffFields,
  summarizeChangeSet,
  renderChangeSet,
} from "@intentius/chant/reconcile";
import type {
  ChangeSet,
  ChangeSetEntry,
  DiffOptions,
  FieldChange,
} from "@intentius/chant/reconcile";
import type {
  NodeConfig,
  GroupSettings,
  ProjectSettings,
  MemberConfig,
  ProtectedBranchConfig,
  ProtectedTagConfig,
  ProtectedEnvironmentConfig,
  DeployKeyConfig,
  DeployTokenConfig,
  AccessTokenConfig,
  MemberRoleConfig,
  ComplianceFrameworkConfig,
  PushRulesConfig,
  ApprovalRuleConfig,
  ApprovalSettings,
  VariableConfig,
  WebhookConfig,
  IntegrationConfig,
  BaselineConfig,
} from "../config/types.js";
import type {
  LiveNodeState,
  LiveGroupSettings,
  LiveProjectSettings,
  LiveMember,
  LiveProtectedBranch,
  LiveProtectedTag,
  LiveProtectedEnvironment,
  LiveDeployKey,
  LiveDeployToken,
  LiveAccessToken,
  LiveMemberRole,
  LiveComplianceFramework,
  LivePushRules,
  LiveApprovalRule,
  LiveApprovalSettings,
  LiveVariable,
  LiveWebhook,
  LiveIntegration,
} from "./live.js";
import { toAccessNumber } from "../config/access-levels.js";

// Re-export the shared change-set surface so cycles import it from here.
export type { ChangeSet, ChangeSetEntry, DiffOptions, FieldChange } from "@intentius/chant/reconcile";
export { summarizeChangeSet, renderChangeSet } from "@intentius/chant/reconcile";

const RESOURCE_TYPE_ORDER = [
  "group-settings",
  "project-settings",
  "push-rules",
  "approval-settings",
  "job-token-scope",
  "security-policy",
  "baseline",
  "member",
  "protected-branch",
  "protected-tag",
  "protected-environment",
  "deploy-key",
  "deploy-token",
  "access-token",
  "member-role",
  "compliance-framework",
  "approval-rule",
  "variable",
  "webhook",
  "integration",
  "instance-settings",
  "instance-variable",
  "system-hook",
] as const;

export function diff(
  node: string,
  desired: NodeConfig,
  live: LiveNodeState,
  opts: DiffOptions = {},
): ChangeSet {
  const entries: ChangeSetEntry[] = [];

  diffObject("group-settings", desired.groupSettings, live.groupSettings, GROUP_FIELDS, entries);
  diffObject("project-settings", desired.projectSettings, live.projectSettings, PROJECT_FIELDS, entries);
  diffObject("push-rules", desired.pushRules, live.pushRules, PUSH_RULE_FIELDS, entries);
  diffObject("approval-settings", desired.approvalSettings, live.approvalSettings, APPROVAL_SETTING_FIELDS, entries);
  diffObject("job-token-scope", desired.jobTokenScope, live.jobTokenScope, ["inboundEnabled"], entries);
  diffObject("security-policy", desired.securityPolicy, live.securityPolicy, ["policyProject"], entries);
  diffMembers(desired.members, live.members ?? [], opts, entries);
  diffProtectedBranches(desired.protectedBranches, live.protectedBranches ?? [], opts, entries);
  diffProtectedTags(desired.protectedTags, live.protectedTags ?? [], opts, entries);
  diffProtectedEnvironments(desired.protectedEnvironments, live.protectedEnvironments ?? [], opts, entries);
  diffDeployKeys(desired.deployKeys, live.deployKeys ?? [], opts, entries);
  diffDeployTokens(desired.deployTokens, live.deployTokens ?? [], opts, entries);
  diffAccessTokens(desired.accessTokens, live.accessTokens ?? [], opts, entries);
  diffMemberRoles(desired.memberRoles, live.memberRoles ?? [], opts, entries);
  diffComplianceFrameworks(desired.complianceFrameworks, live.complianceFrameworks ?? [], opts, entries);
  diffApprovalRules(desired.approvalRules, live.approvalRules ?? [], opts, entries);
  diffVariables(desired.variables, live.variables ?? [], opts, entries);
  diffWebhooks(desired.webhooks, live.webhooks ?? [], opts, entries);
  diffIntegrations(desired.integrations, live.integrations ?? [], opts, entries);
  diffObject("instance-settings", desired.instanceSettings, live.instanceSettings, desired.instanceSettings ? Object.keys(desired.instanceSettings) : [], entries);
  diffVariablesAs("instance-variable", desired.instanceVariables, live.instanceVariables ?? [], opts, entries);
  diffWebhooksAs("system-hook", desired.systemHooks, live.systemHooks ?? [], opts, entries);
  diffBaselines(desired.baselines, live.children ?? [], entries);

  const typeIndex = (t: string): number => {
    const i = (RESOURCE_TYPE_ORDER as readonly string[]).indexOf(t);
    return i === -1 ? RESOURCE_TYPE_ORDER.length : i;
  };
  entries.sort((a, b) => {
    const ti = typeIndex(a.resourceType) - typeIndex(b.resourceType);
    return ti !== 0 ? ti : a.key.localeCompare(b.key);
  });

  return { org: node, entries };
}

// ---------------------------------------------------------------------------
// Single-object slices (settings, push rules)
// ---------------------------------------------------------------------------

const GROUP_FIELDS = [
  "name",
  "description",
  "visibility",
  "requestAccessEnabled",
  "projectCreationLevel",
  "subgroupCreationLevel",
  "preventForkingOutsideGroup",
  "mentionsDisabled",
];
const PROJECT_FIELDS = [
  "description",
  "visibility",
  "defaultBranch",
  "mergeMethod",
  "squashOption",
  "onlyAllowMergeIfPipelineSucceeds",
  "onlyAllowMergeIfAllDiscussionsAreResolved",
  "removeSourceBranchAfterMerge",
];
const PUSH_RULE_FIELDS = [
  "commitMessageRegex",
  "commitMessageNegativeRegex",
  "branchNameRegex",
  "authorEmailRegex",
  "fileNameRegex",
  "maxFileSize",
  "preventSecrets",
  "memberCheck",
  "rejectUnsignedCommits",
  "rejectNonDcoCommits",
];
const APPROVAL_SETTING_FIELDS = [
  "resetApprovalsOnPush",
  "disableOverridingApproversPerMergeRequest",
  "mergeRequestsAuthorApproval",
  "mergeRequestsDisableCommittersApproval",
  "requirePasswordToApprove",
];

function diffObject(
  resourceType: string,
  desired: object | undefined,
  live: object | undefined,
  fields: string[],
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  if (live === undefined) {
    out.push({ kind: "create", resourceType, key: resourceType, after: desired });
    return;
  }
  // project-settings carries topics (array) handled here for project only.
  const changed = diffFields(desired as Record<string, unknown>, live as Record<string, unknown>, fields);
  if (resourceType === "project-settings") {
    const d = desired as ProjectSettings;
    const l = live as LiveProjectSettings;
    if (d.topics !== undefined) {
      const a = [...d.topics].sort().join(",");
      const b = [...(l.topics ?? [])].sort().join(",");
      if (a !== b) changed.push({ field: "topics", before: l.topics ?? [], after: d.topics });
    }
  }
  if (changed.length > 0) {
    out.push({ kind: "update", resourceType, key: resourceType, before: live, after: desired, fields: changed });
  }
}

// ---------------------------------------------------------------------------
// Members (direct only; access-level compared)
// ---------------------------------------------------------------------------

function diffMembers(
  desired: MemberConfig[] | undefined,
  live: LiveMember[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<MemberConfig, LiveMember>({
    resourceType: "member",
    desired: new Map(desired.map((m) => [String(m.user), m])),
    live: new Map(live.map((m) => [m.username, m])),
    compareFields: (dm, lm) => {
      const fields: FieldChange[] = [];
      const want = toAccessNumber(dm.accessLevel);
      if (want !== lm.accessLevel) fields.push({ field: "accessLevel", before: lm.accessLevel, after: want });
      if (dm.memberRoleId !== undefined && dm.memberRoleId !== lm.memberRoleId) {
        fields.push({ field: "memberRoleId", before: lm.memberRoleId, after: dm.memberRoleId });
      }
      return fields;
    },
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Protected branches / tags
// ---------------------------------------------------------------------------

const PB_FIELDS = ["pushAccessLevel", "mergeAccessLevel", "unprotectAccessLevel", "allowForcePush", "codeOwnerApprovalRequired"];

function diffProtectedBranches(
  desired: ProtectedBranchConfig[] | undefined,
  live: LiveProtectedBranch[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<ProtectedBranchConfig, LiveProtectedBranch>({
    resourceType: "protected-branch",
    desired: new Map(desired.map((b) => [b.name, b])),
    live: new Map(live.map((b) => [b.name, b])),
    compareFields: (db, lb) =>
      diffFields(db as unknown as Record<string, unknown>, lb as unknown as Record<string, unknown>, PB_FIELDS),
    opts,
    out,
  });
}

function diffProtectedTags(
  desired: ProtectedTagConfig[] | undefined,
  live: LiveProtectedTag[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<ProtectedTagConfig, LiveProtectedTag>({
    resourceType: "protected-tag",
    desired: new Map(desired.map((t) => [t.name, t])),
    live: new Map(live.map((t) => [t.name, t])),
    compareFields: (dt, lt) =>
      diffFields(dt as unknown as Record<string, unknown>, lt as unknown as Record<string, unknown>, ["createAccessLevel"]),
    opts,
    out,
  });
}

function diffProtectedEnvironments(
  desired: ProtectedEnvironmentConfig[] | undefined,
  live: LiveProtectedEnvironment[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<ProtectedEnvironmentConfig, LiveProtectedEnvironment>({
    resourceType: "protected-environment",
    desired: new Map(desired.map((e) => [e.name, e])),
    live: new Map(live.map((e) => [e.name, e])),
    compareFields: (de, le) => {
      const fields = diffFields(de as unknown as Record<string, unknown>, le as unknown as Record<string, unknown>, ["requiredApprovalCount"]);
      if (de.deployAccessLevels !== undefined) {
        const a = [...de.deployAccessLevels].sort().join(",");
        const b = [...(le.deployAccessLevels ?? [])].sort().join(",");
        if (a !== b) fields.push({ field: "deployAccessLevels", before: le.deployAccessLevels ?? [], after: de.deployAccessLevels });
      }
      return fields;
    },
    opts,
    out,
  });
}

function diffDeployKeys(
  desired: DeployKeyConfig[] | undefined,
  live: LiveDeployKey[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<DeployKeyConfig, LiveDeployKey>({
    resourceType: "deploy-key",
    desired: new Map(desired.map((k) => [k.title, k])),
    live: new Map(live.map((k) => [k.title, k])),
    compareFields: (dk, lk) => diffFields(dk as unknown as Record<string, unknown>, lk as unknown as Record<string, unknown>, ["canPush"]),
    opts,
    out,
  });
}

function diffDeployTokens(
  desired: DeployTokenConfig[] | undefined,
  live: LiveDeployToken[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  // Tokens are immutable — reconciled by presence (create/delete only).
  diffCollection<DeployTokenConfig, LiveDeployToken>({
    resourceType: "deploy-token",
    desired: new Map(desired.map((t) => [t.name, t])),
    live: new Map(live.map((t) => [t.name, t])),
    compareFields: () => [],
    opts,
    out,
  });
}

function diffAccessTokens(
  desired: AccessTokenConfig[] | undefined,
  live: LiveAccessToken[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  // Access tokens are immutable — reconciled by presence (create/delete only).
  diffCollection<AccessTokenConfig, LiveAccessToken>({
    resourceType: "access-token",
    desired: new Map(desired.map((t) => [t.name, t])),
    live: new Map(live.map((t) => [t.name, t])),
    compareFields: () => [],
    opts,
    out,
  });
}

function diffMemberRoles(
  desired: MemberRoleConfig[] | undefined,
  live: LiveMemberRole[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  // Custom roles reconciled by presence (create/delete) — keyed by name.
  diffCollection<MemberRoleConfig, LiveMemberRole>({
    resourceType: "member-role",
    desired: new Map(desired.map((r) => [r.name, r])),
    live: new Map(live.map((r) => [r.name, r])),
    compareFields: () => [],
    opts,
    out,
  });
}

function diffComplianceFrameworks(
  desired: ComplianceFrameworkConfig[] | undefined,
  live: LiveComplianceFramework[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<ComplianceFrameworkConfig, LiveComplianceFramework>({
    resourceType: "compliance-framework",
    desired: new Map(desired.map((f) => [f.name, f])),
    live: new Map(live.map((f) => [f.name, f])),
    compareFields: (df, lf) =>
      diffFields(df as unknown as Record<string, unknown>, lf as unknown as Record<string, unknown>, ["description", "color", "pipelineConfigurationFullPath"]),
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Approval rules
// ---------------------------------------------------------------------------

function diffApprovalRules(
  desired: ApprovalRuleConfig[] | undefined,
  live: LiveApprovalRule[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<ApprovalRuleConfig, LiveApprovalRule>({
    resourceType: "approval-rule",
    desired: new Map(desired.map((r) => [r.name, r])),
    live: new Map(live.map((r) => [r.name, r])),
    compareFields: (dr, lr) => {
      const fields = diffFields(dr as unknown as Record<string, unknown>, lr as unknown as Record<string, unknown>, ["approvalsRequired"]);
      for (const f of ["userIds", "groupIds", "protectedBranchIds"] as const) {
        if (dr[f] !== undefined) {
          const a = [...(dr[f] ?? [])].sort().join(",");
          const b = [...(lr[f] ?? [])].sort().join(",");
          if (a !== b) fields.push({ field: f, before: lr[f] ?? [], after: dr[f] });
        }
      }
      return fields;
    },
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// CI/CD variables (keyed by key + environment scope)
// ---------------------------------------------------------------------------

function varKey(key: string, scope?: string): string {
  return `${key}@${scope ?? "*"}`;
}

function diffVariables(
  desired: VariableConfig[] | undefined,
  live: LiveVariable[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  diffVariablesAs("variable", desired, live, opts, out);
}

function diffVariablesAs(
  resourceType: "variable" | "instance-variable",
  desired: VariableConfig[] | undefined,
  live: LiveVariable[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<VariableConfig, LiveVariable>({
    resourceType,
    desired: new Map(desired.map((v) => [varKey(v.key, v.environmentScope), v])),
    live: new Map(live.map((v) => [varKey(v.key, v.environmentScope), v])),
    compareFields: (dv, lv) => {
      const fields: FieldChange[] = [];
      if (dv.value !== undefined && dv.value !== lv.value) fields.push({ field: "value", before: lv.value, after: dv.value });
      for (const f of ["protected", "masked", "variableType"] as const) {
        if (dv[f] !== undefined && dv[f] !== lv[f]) fields.push({ field: f, before: lv[f], after: dv[f] });
      }
      return fields;
    },
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Webhooks (keyed by url; live id carried for apply)
// ---------------------------------------------------------------------------

const HOOK_FIELDS = ["pushEvents", "mergeRequestsEvents", "tagPushEvents", "issuesEvents", "pipelineEvents", "enableSslVerification"];

function diffWebhooks(
  desired: WebhookConfig[] | undefined,
  live: LiveWebhook[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  diffWebhooksAs("webhook", desired, live, opts, out);
}

function diffWebhooksAs(
  resourceType: "webhook" | "system-hook",
  desired: WebhookConfig[] | undefined,
  live: LiveWebhook[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<WebhookConfig, LiveWebhook>({
    resourceType,
    desired: new Map(desired.map((w) => [w.url, w])),
    live: new Map(live.map((w) => [w.url, w])),
    compareFields: (dw, lw) =>
      diffFields(dw as unknown as Record<string, unknown>, lw as unknown as Record<string, unknown>, HOOK_FIELDS),
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Integrations (presence + active; properties are write-only, not diffed)
// ---------------------------------------------------------------------------

function diffIntegrations(
  desired: IntegrationConfig[] | undefined,
  live: LiveIntegration[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  diffCollection<IntegrationConfig, LiveIntegration>({
    resourceType: "integration",
    desired: new Map(desired.map((i) => [i.name, i])),
    live: new Map(live.map((i) => [i.name, i])),
    compareFields: (di, li) =>
      di.active !== undefined && di.active !== li.active ? [{ field: "active", before: li.active, after: di.active }] : [],
    opts,
    out,
  });
}

// ---------------------------------------------------------------------------
// Baselines (existence only)
// ---------------------------------------------------------------------------

function diffBaselines(
  desired: BaselineConfig[] | undefined,
  liveChildren: string[],
  out: ChangeSetEntry[],
): void {
  if (desired === undefined) return;
  const have = new Set(liveChildren);
  for (const b of desired) {
    if (!have.has(b.path)) out.push({ kind: "create", resourceType: "baseline", key: b.path, after: b });
  }
}
