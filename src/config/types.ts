/**
 * Desired-state config types for GitLab group/project governance.
 *
 * Selective-by-omission: every field is optional. An absent field means "not
 * managed" — warden will not read, diff, or modify that aspect of live GitLab
 * state. Only explicitly-present fields are reconciled.
 *
 * The unit of governance is a **node** — a single group or project the operator
 * declares, keyed by full path (e.g. `acme/platform`, `acme/platform/api`). Each
 * node carries a `kind` and the per-resource config slices that apply to it (see
 * DESIGN.md for the scope model). The runner turns each node into a reconcile
 * scope; cycles add their own slices to `NodeConfig` as they land.
 */

export type NodeKind = "group" | "project" | "instance";

// ---------------------------------------------------------------------------
// Access levels (see DESIGN.md §2)
// ---------------------------------------------------------------------------

/** Named access levels; also accepts the raw GitLab number. */
export type AccessLevelName =
  | "no_access"
  | "minimal"
  | "guest"
  | "planner"
  | "reporter"
  | "developer"
  | "maintainer"
  | "owner";

export type AccessLevel = AccessLevelName | number;

// ---------------------------------------------------------------------------
// Group / project settings
// ---------------------------------------------------------------------------

export type Visibility = "private" | "internal" | "public";

/** Group settings (`PUT /groups/:id`). Absent fields are not managed. */
export interface GroupSettings {
  name?: string;
  description?: string;
  visibility?: Visibility;
  requestAccessEnabled?: boolean;
  projectCreationLevel?: "noone" | "maintainer" | "developer";
  subgroupCreationLevel?: "owner" | "maintainer";
  preventForkingOutsideGroup?: boolean;
  mentionsDisabled?: boolean;
}

/** Project settings (`PUT /projects/:id`). Absent fields are not managed. */
export interface ProjectSettings {
  description?: string;
  visibility?: Visibility;
  defaultBranch?: string;
  /** "merge" | "rebase_merge" | "ff". */
  mergeMethod?: string;
  squashOption?: "never" | "always" | "default_on" | "default_off";
  onlyAllowMergeIfPipelineSucceeds?: boolean;
  onlyAllowMergeIfAllDiscussionsAreResolved?: boolean;
  removeSourceBranchAfterMerge?: boolean;
  topics?: string[];
}

// ---------------------------------------------------------------------------
// Members (see DESIGN.md — diffed against DIRECT membership only)
// ---------------------------------------------------------------------------

/** A direct member of a group or project. */
export interface MemberConfig {
  /** Username or numeric user id. */
  user: string | number;
  accessLevel: AccessLevel;
  /** Custom member role id (Ultimate) — pairs with a base accessLevel. */
  memberRoleId?: number;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Protected branches / tags
// ---------------------------------------------------------------------------

export interface ProtectedBranchConfig {
  /** Branch name or glob (the identity key). */
  name: string;
  /** CE: numeric access levels. */
  pushAccessLevel?: number;
  mergeAccessLevel?: number;
  unprotectAccessLevel?: number;
  allowForcePush?: boolean;
  codeOwnerApprovalRequired?: boolean;
}

export interface ProtectedTagConfig {
  name: string;
  createAccessLevel?: number;
}

/** A protected environment (group or project; Premium). Keyed by `name`. */
export interface ProtectedEnvironmentConfig {
  name: string;
  /** Access levels allowed to deploy. */
  deployAccessLevels?: number[];
  requiredApprovalCount?: number;
}

// ---------------------------------------------------------------------------
// Deploy keys & tokens
// ---------------------------------------------------------------------------

/** A project deploy key (keyed by title). The public `key` is set on create. */
export interface DeployKeyConfig {
  title: string;
  key: string;
  canPush?: boolean;
}

/** A group/project deploy token (keyed by name). Immutable — reconciled by presence. */
export interface DeployTokenConfig {
  name: string;
  scopes?: string[];
  expiresAt?: string;
  username?: string;
}

/** A group/project access token (bot, keyed by name). Immutable — reconciled by presence. */
export interface AccessTokenConfig {
  name: string;
  scopes?: string[];
  accessLevel?: AccessLevel;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Push rules
// ---------------------------------------------------------------------------

/** Push rules — project (`/projects/:id/push_rule`) or group default (Group attrs). */
export interface PushRulesConfig {
  commitMessageRegex?: string;
  commitMessageNegativeRegex?: string;
  branchNameRegex?: string;
  authorEmailRegex?: string;
  fileNameRegex?: string;
  maxFileSize?: number;
  preventSecrets?: boolean;
  memberCheck?: boolean;
  rejectUnsignedCommits?: boolean;
  rejectNonDcoCommits?: boolean;
}

// ---------------------------------------------------------------------------
// Merge request approvals
// ---------------------------------------------------------------------------

/** A named approval rule (`/projects/:id/approval_rules`). Keyed by `name`. */
export interface ApprovalRuleConfig {
  name: string;
  approvalsRequired?: number;
  userIds?: number[];
  groupIds?: number[];
  protectedBranchIds?: number[];
}

/** Project-level approval settings (`/projects/:id/approvals`). */
export interface ApprovalSettings {
  resetApprovalsOnPush?: boolean;
  disableOverridingApproversPerMergeRequest?: boolean;
  mergeRequestsAuthorApproval?: boolean;
  mergeRequestsDisableCommittersApproval?: boolean;
  requirePasswordToApprove?: boolean;
}

// ---------------------------------------------------------------------------
// CI/CD variables
// ---------------------------------------------------------------------------

/** A CI/CD variable (group or project). Keyed by (key, environmentScope). */
export interface VariableConfig {
  key: string;
  value?: string;
  environmentScope?: string;
  protected?: boolean;
  masked?: boolean;
  /** "env_var" | "file". */
  variableType?: string;
}

// ---------------------------------------------------------------------------
// Integrations (generic)
// ---------------------------------------------------------------------------

/**
 * A group/project integration (Slack, Jira, …), modeled generically so any
 * integration is reconcilable without per-service code. Keyed by `name` (the
 * GitLab integration slug). `properties` are write-only (GitLab masks them), so
 * property-only drift isn't detected — presence/active is reconciled.
 */
export interface IntegrationConfig {
  name: string;
  active?: boolean;
  properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** A group or project webhook. Keyed by `url`. */
export interface WebhookConfig {
  url: string;
  /**
   * Former hook URL — an explicit rename intent, no `owned` needed: when a
   * live hook by the old URL exists (and none by the new URL), the plan is a
   * single update that keeps the hook id. Ignored on `systemHooks` (the
   * system-hooks API has no update endpoint, so delete + re-create is honest
   * there).
   */
  previously?: string;
  pushEvents?: boolean;
  mergeRequestsEvents?: boolean;
  tagPushEvents?: boolean;
  issuesEvents?: boolean;
  pipelineEvents?: boolean;
  enableSslVerification?: boolean;
  /** Write-only secret token (never read back). */
  token?: string;
}

// ---------------------------------------------------------------------------
// Provisioning (baseline)
// ---------------------------------------------------------------------------

/** A subgroup or project that must exist under this node. */
export interface BaselineConfig {
  /** "group" | "project". */
  kind: NodeKind;
  /** Path segment (name) of the child to create. */
  path: string;
  name?: string;
  visibility?: Visibility;
  /** Project template "namespace/template" to generate from (projects only). */
  template?: string;
}

// ---------------------------------------------------------------------------
// Compliance frameworks (GraphQL; group nodes; Premium/Ultimate)
// ---------------------------------------------------------------------------

/** A compliance framework defined on a top-level group. Keyed by name. */
export interface ComplianceFrameworkConfig {
  name: string;
  description?: string;
  /** Hex colour, e.g. "#1aaa55". */
  color?: string;
  /** Path to the enforced pipeline configuration ("file@group/project"). */
  pipelineConfigurationFullPath?: string;
}

// ---------------------------------------------------------------------------
// Security policies (GraphQL; group/project; Ultimate)
// ---------------------------------------------------------------------------

/**
 * Security policy linkage for a group/project — which security policy project is
 * linked. The policy *content* (`.gitlab/security-policies/policy.yml`) lives in
 * that project and is reconciled separately (deferred follow-up under #18).
 */
export interface SecurityPolicyConfig {
  /** Full path of the linked security policy project (empty/unset → unlink). */
  policyProject?: string;
}

// ---------------------------------------------------------------------------
// Advanced protections
// ---------------------------------------------------------------------------

/** CI/CD job token scope (project). Controls inbound token access. */
export interface JobTokenScopeConfig {
  /** Whether other projects need to be allowlisted to use this project's job token. */
  inboundEnabled?: boolean;
}

/** A custom member role (Ultimate; group or instance). Keyed by name. */
export interface MemberRoleConfig {
  name: string;
  baseAccessLevel: AccessLevel;
  /** Enabled fine-grained permissions, e.g. ["read_code", "admin_merge_request"]. */
  permissions?: string[];
}

// ---------------------------------------------------------------------------
// Node + top-level config
// ---------------------------------------------------------------------------

/**
 * A pending node rename, resolved by the runner from a node's `previously:`
 * declaration (see `NodeConfig.previously`). Runner-injected into the scope's
 * config — never written by operators.
 */
export interface NodeRenameIntent {
  /** Current live full path (the node's `previously`). */
  fromPath: string;
  /** Declared full path (the node's key in `nodes{}`). */
  toPath: string;
  /** Display name to set alongside the path, when no settings slice manages it. */
  name?: string;
}

/**
 * Desired state for a single node (group or project). Slices are present only
 * when managed. Later cycles extend this with their own slices.
 */
export interface NodeConfig {
  kind: NodeKind;
  /**
   * Former full path of this node — an explicit rename intent, no `owned`
   * needed: when the live group/project exists at the old path (and none
   * exists at the declared path), the runner adopts the live resource under
   * its old path and the plan is a single update (`PUT /groups/:id` /
   * `PUT /projects/:id` with the new path) that keeps the id, history, and
   * memberships. Must share the declared path's parent namespace (transfers
   * are a different API and unsupported). Not valid on instance nodes.
   */
  previously?: string;
  /** Runner-injected pending rename (from `previously`). Not operator config. */
  nodeRename?: NodeRenameIntent;
  /**
   * Ownership declaration for this node's reconciled collections — the gate on
   * planned deletes. Absent or `false` (the default): no deletes are planned in
   * this node's scope; a live entry you did not declare is left alone. `true`:
   * warden owns every resource collection it reconciles here, so a live entry
   * absent from config becomes a delete. A string array: warden owns only the
   * listed resource types (the ChangeSet entry types — `RESOURCE_TYPE_ORDER`
   * in `src/reconcile/diff.ts`, e.g. `"member"`, `"webhook"`, `"variable"`).
   * A caller-supplied `diffOptions.isOwned` (library use) overrides this.
   */
  owned?: boolean | string[];
  /** Group-node settings (`kind: "group"`). */
  groupSettings?: GroupSettings;
  /** Project-node settings (`kind: "project"`). */
  projectSettings?: ProjectSettings;
  members?: MemberConfig[];
  protectedBranches?: ProtectedBranchConfig[];
  protectedTags?: ProtectedTagConfig[];
  protectedEnvironments?: ProtectedEnvironmentConfig[];
  deployKeys?: DeployKeyConfig[];
  deployTokens?: DeployTokenConfig[];
  accessTokens?: AccessTokenConfig[];
  pushRules?: PushRulesConfig;
  jobTokenScope?: JobTokenScopeConfig;
  memberRoles?: MemberRoleConfig[];
  complianceFrameworks?: ComplianceFrameworkConfig[];
  securityPolicy?: SecurityPolicyConfig;
  approvalRules?: ApprovalRuleConfig[];
  approvalSettings?: ApprovalSettings;
  variables?: VariableConfig[];
  webhooks?: WebhookConfig[];
  integrations?: IntegrationConfig[];
  baselines?: BaselineConfig[];
  /** Instance application settings (self-managed) — generic passthrough of GitLab `application_settings` keys. */
  instanceSettings?: Record<string, unknown>;
  /** Instance system hooks (self-managed). */
  systemHooks?: WebhookConfig[];
  /** Instance CI/CD variables (self-managed). */
  instanceVariables?: VariableConfig[];
}

/** Top-level governance config: the declared nodes, keyed by full path. */
export interface GovernanceConfig {
  nodes: Record<string, NodeConfig>;
}
