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
  PipelineScheduleConfig,
  PipelineScheduleVariableConfig,
  WebhookConfig,
  IntegrationConfig,
  BaselineConfig,
  NodeRenameIntent,
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
  LivePipelineSchedule,
  LivePipelineScheduleVariable,
  LiveWebhook,
  LiveIntegration,
} from "./live.js";
import { toAccessNumber } from "../config/access-levels.js";

// Re-export the shared change-set surface so cycles import it from here.
export type { ChangeSet, ChangeSetEntry, DiffOptions, FieldChange } from "@intentius/chant/reconcile";
export { summarizeChangeSet, renderChangeSet } from "@intentius/chant/reconcile";

/**
 * Every resource type a ChangeSet entry can carry, in render order. Also the
 * vocabulary for a node's `owned: [...]` declaration (`NodeConfig.owned`).
 */
export const RESOURCE_TYPE_ORDER = [
  "node",
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
  "pipeline-schedule",
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

  // Per-type live counts for chant's per-collection removal cap
  // (`ChangeSet.managedCounts`), summed natively during the walk from what
  // each collection diff returns. Only delete-capable collections contribute:
  // single-object slices (settings, push rules), create-only baselines, and
  // the node-rename shape never plan deletes, so they must not appear here —
  // a type absent from the record falls back to chant's per-type
  // plan-relative denominator. Because a pending node rename runs its scope
  // under the OLD path, the live entries counted here are the same ones the
  // entries were diffed against, so rename counting is naturally correct.
  const managedCounts: Record<string, number> = {};
  const counted = (resourceType: string, liveCount: number | undefined): void => {
    if (liveCount !== undefined) managedCounts[resourceType] = liveCount;
  };

  diffNodeRename(desired.nodeRename, entries);
  diffObject("group-settings", desired.groupSettings, live.groupSettings, GROUP_FIELDS, entries);
  diffObject("project-settings", desired.projectSettings, live.projectSettings, PROJECT_FIELDS, entries);
  diffObject("push-rules", desired.pushRules, live.pushRules, PUSH_RULE_FIELDS, entries);
  diffObject("approval-settings", desired.approvalSettings, live.approvalSettings, APPROVAL_SETTING_FIELDS, entries);
  diffObject("job-token-scope", desired.jobTokenScope, live.jobTokenScope, ["inboundEnabled"], entries);
  diffObject("security-policy", desired.securityPolicy, live.securityPolicy, ["policyProject"], entries);
  counted("member", diffMembers(desired.members, live.members ?? [], opts, entries));
  counted("protected-branch", diffProtectedBranches(desired.protectedBranches, live.protectedBranches ?? [], opts, entries));
  counted("protected-tag", diffProtectedTags(desired.protectedTags, live.protectedTags ?? [], opts, entries));
  counted("protected-environment", diffProtectedEnvironments(desired.protectedEnvironments, live.protectedEnvironments ?? [], opts, entries));
  counted("deploy-key", diffDeployKeys(desired.deployKeys, live.deployKeys ?? [], opts, entries));
  counted("deploy-token", diffDeployTokens(desired.deployTokens, live.deployTokens ?? [], opts, entries));
  counted("access-token", diffAccessTokens(desired.accessTokens, live.accessTokens ?? [], opts, entries));
  counted("member-role", diffMemberRoles(desired.memberRoles, live.memberRoles ?? [], opts, entries));
  counted("compliance-framework", diffComplianceFrameworks(desired.complianceFrameworks, live.complianceFrameworks ?? [], opts, entries));
  counted("approval-rule", diffApprovalRules(desired.approvalRules, live.approvalRules ?? [], opts, entries));
  counted("variable", diffVariables(desired.variables, live.variables ?? [], opts, entries));
  counted("pipeline-schedule", diffPipelineSchedules(desired.pipelineSchedules, live.pipelineSchedules ?? [], opts, entries));
  counted("webhook", diffWebhooks(desired.webhooks, live.webhooks ?? [], opts, entries));
  counted("integration", diffIntegrations(desired.integrations, live.integrations ?? [], opts, entries));
  diffObject("instance-settings", desired.instanceSettings, live.instanceSettings, desired.instanceSettings ? Object.keys(desired.instanceSettings) : [], entries);
  counted("instance-variable", diffVariablesAs("instance-variable", desired.instanceVariables, live.instanceVariables ?? [], opts, entries));
  counted("system-hook", diffWebhooksAs("system-hook", desired.systemHooks, live.systemHooks ?? [], opts, entries));
  diffBaselines(desired.baselines, live.children ?? [], entries);

  const typeIndex = (t: string): number => {
    const i = (RESOURCE_TYPE_ORDER as readonly string[]).indexOf(t);
    return i === -1 ? RESOURCE_TYPE_ORDER.length : i;
  };
  entries.sort((a, b) => {
    const ti = typeIndex(a.resourceType) - typeIndex(b.resourceType);
    return ti !== 0 ? ti : a.key.localeCompare(b.key);
  });

  return { org: node, entries, managedCounts };
}

// ---------------------------------------------------------------------------
// Node rename (runner-resolved `previously:` — see runner.ts)
// ---------------------------------------------------------------------------

/**
 * A runner-injected `nodeRename` slice is an already-verified rename intent:
 * the runner probed live state while resolving the node's `previously:` alias
 * (the live resource exists at `fromPath`, none at `toPath`) and enumerated
 * the scope under the old path. The diff's job is just to shape it as ONE
 * update — never a delete + create, so no `owned` requirement and nothing for
 * the removal guardrails to count. The synthetic `key` field matches chant's
 * `resolveRenames` collapse shape.
 */
function diffNodeRename(desired: NodeRenameIntent | undefined, out: ChangeSetEntry[]): void {
  if (desired === undefined) return;
  const fields: FieldChange[] = [{ field: "key", before: desired.fromPath, after: desired.toPath }];
  out.push({
    kind: "update",
    resourceType: "node",
    key: desired.toPath,
    before: { path: desired.fromPath },
    after: desired,
    fields,
  });
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
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<MemberConfig, LiveMember>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<ProtectedBranchConfig, LiveProtectedBranch>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<ProtectedTagConfig, LiveProtectedTag>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<ProtectedEnvironmentConfig, LiveProtectedEnvironment>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<DeployKeyConfig, LiveDeployKey>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  // Tokens are immutable — reconciled by presence (create/delete only).
  return diffCollection<DeployTokenConfig, LiveDeployToken>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  // Access tokens are immutable — reconciled by presence (create/delete only).
  return diffCollection<AccessTokenConfig, LiveAccessToken>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  // Custom roles reconciled by presence (create/delete) — keyed by name.
  return diffCollection<MemberRoleConfig, LiveMemberRole>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<ComplianceFrameworkConfig, LiveComplianceFramework>({
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
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<ApprovalRuleConfig, LiveApprovalRule>({
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
): number | undefined {
  return diffVariablesAs("variable", desired, live, opts, out);
}

function diffVariablesAs(
  resourceType: "variable" | "instance-variable",
  desired: VariableConfig[] | undefined,
  live: LiveVariable[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): number | undefined {
  if (desired === undefined) return undefined;
  return diffCollection<VariableConfig, LiveVariable>({
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
// Pipeline schedules (keyed by description; live id carried for apply)
// ---------------------------------------------------------------------------

const SCHEDULE_FIELDS = ["cron", "cronTimezone", "ref", "active"];

/**
 * Whether one declared schedule variable needs a write against its live
 * counterpart (absent live, value drift, or a declared `variableType` that
 * differs). Selective per field: `variableType` is compared only when declared
 * (live always reports GitLab's default "env_var", which an omitted type must
 * not fight). THE schedule-variable drift rule — the diff's convergence check
 * and the pipeline-schedules apply path both consume it, so it exists once.
 */
export function scheduleVarNeedsWrite(
  desired: PipelineScheduleVariableConfig,
  live: LivePipelineScheduleVariable | undefined,
): boolean {
  if (live === undefined) return true;
  if (desired.value !== live.value) return true;
  return desired.variableType !== undefined && desired.variableType !== live.variableType;
}

/**
 * Whether a schedule's declared variables are converged with live, compared by
 * key. Deleting a live variable you did not declare is an undeclared-entry
 * prune, so it is drift only when the schedule is owned (`deleteExtras`):
 * without ownership a live-extra variable is LEFT ALONE — flagging it would be
 * a perpetual plan the apply path may not act on.
 */
function scheduleVarsConverged(
  desired: PipelineScheduleVariableConfig[],
  live: LivePipelineScheduleVariable[],
  deleteExtras: boolean,
): boolean {
  const have = new Map(live.map((v) => [v.key, v]));
  if (deleteExtras) {
    const want = new Set(desired.map((v) => v.key));
    if (live.some((v) => !want.has(v.key))) return false;
  }
  return desired.every((d) => !scheduleVarNeedsWrite(d, have.get(d.key)));
}

/**
 * The variable list the apply path should converge a schedule to: the declared
 * variables, plus — when the schedule is NOT owned — the live extras carried
 * over verbatim, so the apply's delete loop (driven by this list) never prunes
 * an undeclared variable without ownership.
 */
function scheduleVarsTarget(
  desired: PipelineScheduleVariableConfig[],
  live: LivePipelineScheduleVariable[],
  deleteExtras: boolean,
): PipelineScheduleVariableConfig[] {
  if (deleteExtras) return desired;
  const want = new Set(desired.map((v) => v.key));
  const kept = live
    .filter((v) => !want.has(v.key))
    .map((v) => {
      const keep: PipelineScheduleVariableConfig = { key: v.key, value: v.value ?? "" };
      if (v.variableType !== undefined) keep.variableType = v.variableType;
      return keep;
    });
  return [...desired, ...kept];
}

function diffPipelineSchedules(
  desired: PipelineScheduleConfig[] | undefined,
  live: LivePipelineSchedule[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): number | undefined {
  if (desired === undefined) return undefined;
  // Live-extra variables on a schedule are deletable only when the schedule
  // itself is owned — the same gate its delete entries run under.
  const owns = (key: string): boolean => opts.isOwned?.("pipeline-schedule", key) === true;
  return diffCollection<PipelineScheduleConfig, LivePipelineSchedule>({
    resourceType: "pipeline-schedule",
    desired: new Map(desired.map((s) => [s.description, s])),
    live: new Map(live.map((s) => [s.description, s])),
    compareFields: (ds, ls) => {
      const fields = diffFields(ds as unknown as Record<string, unknown>, ls as unknown as Record<string, unknown>, SCHEDULE_FIELDS);
      // Variables reconciled by key — selective by omission like every slice:
      // an undeclared `variables` leaves live variables alone.
      if (ds.variables !== undefined && !scheduleVarsConverged(ds.variables, ls.variables ?? [], owns(ds.description))) {
        fields.push({
          field: "variables",
          before: ls.variables ?? [],
          after: scheduleVarsTarget(ds.variables, ls.variables ?? [], owns(ds.description)),
        });
      }
      return fields;
    },
    // The apply path converges variables to `after.variables`, so hand it the
    // ownership-aware target list rather than the raw declaration.
    updateAfter: (key, ds, ls) =>
      ds.variables === undefined ? ds : { ...ds, variables: scheduleVarsTarget(ds.variables, ls.variables ?? [], owns(key)) },
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
): number | undefined {
  return diffWebhooksAs("webhook", desired, live, opts, out);
}

function diffWebhooksAs(
  resourceType: "webhook" | "system-hook",
  desired: WebhookConfig[] | undefined,
  live: LiveWebhook[],
  opts: DiffOptions,
  out: ChangeSetEntry[],
): number | undefined {
  if (desired === undefined) return undefined;

  // An explicit `previously:` declaration is an explicit rename intent: when a
  // live hook by the previous URL exists and none by the new URL does, plan
  // ONE update (the rename) directly against the old live hook — no
  // delete + create pair, so no `owned` requirement, and the live hook id
  // rides along on `before` for the apply path. System hooks are excluded:
  // their API has no update endpoint, so delete + re-create is honest there.
  // The synthetic `key` field matches chant's `resolveRenames` collapse shape.
  const liveByUrl = new Map(live.map((w) => [w.url, w]));
  const renamedFrom = new Map<string, string>(); // previous URL → new URL
  if (resourceType === "webhook") {
    for (const dw of desired) {
      if (typeof dw.previously === "string" && liveByUrl.has(dw.previously) && !liveByUrl.has(dw.url)) {
        renamedFrom.set(dw.previously, dw.url);
      }
    }
  }
  for (const dw of desired) {
    const prev =
      typeof dw.previously === "string" && renamedFrom.get(dw.previously) === dw.url
        ? dw.previously
        : undefined;
    if (prev === undefined) continue;
    const lw = liveByUrl.get(prev)!;
    const fields = diffFields(dw as unknown as Record<string, unknown>, lw as unknown as Record<string, unknown>, HOOK_FIELDS);
    fields.push({ field: "key", before: prev, after: dw.url });
    out.push({ kind: "update", resourceType, key: dw.url, before: lw, after: dw, fields });
  }

  // Live count: the collection diff sees live minus the rename-adopted hooks,
  // so add those back — a hook being renamed in place is still a live managed
  // entry for the removal cap's denominator.
  return renamedFrom.size + diffCollection<WebhookConfig, LiveWebhook>({
    resourceType,
    desired: new Map(
      desired
        .filter((w) => !(typeof w.previously === "string" && renamedFrom.get(w.previously) === w.url))
        .map((w) => [w.url, w]),
    ),
    live: new Map(live.filter((w) => !renamedFrom.has(w.url)).map((w) => [w.url, w])),
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
): number | undefined {
  if (desired === undefined) return undefined;

  // Declared `active: false` is an explicit disable. GitLab's PUT upsert
  // (re)activates an integration no matter what, so the only way to turn one
  // off is the DELETE path (DELETE /…/integrations/:name deactivates). These
  // deletes bypass ownership gating: they carry declared intent, unlike the
  // undeclared-entry prunes `owned` guards. A declared-off integration absent
  // from live (live holds active ones only) is already converged.
  const liveByName = new Map(live.map((i) => [i.name, i]));
  const enabled: IntegrationConfig[] = [];
  const declaredOff = new Set<string>();
  for (const d of desired) {
    if (d.active === false) {
      declaredOff.add(d.name);
      const l = liveByName.get(d.name);
      if (l) out.push({ kind: "delete", resourceType: "integration", key: d.name, before: l });
    } else {
      enabled.push(d);
    }
  }

  // Live count: the collection diff sees live minus the declared-off entries,
  // so add back those actually present live — they are live managed entries
  // (their declared-intent deletes are counted by the cap like any other).
  const declaredOffLive = live.filter((i) => declaredOff.has(i.name)).length;
  return declaredOffLive + diffCollection<IntegrationConfig, LiveIntegration>({
    resourceType: "integration",
    desired: new Map(enabled.map((i) => [i.name, i])),
    live: new Map(live.filter((i) => !declaredOff.has(i.name)).map((i) => [i.name, i])),
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
