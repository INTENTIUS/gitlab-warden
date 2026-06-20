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

export type NodeKind = "group" | "project";

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
// Webhooks
// ---------------------------------------------------------------------------

/** A group or project webhook. Keyed by `url`. */
export interface WebhookConfig {
  url: string;
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
// Node + top-level config
// ---------------------------------------------------------------------------

/**
 * Desired state for a single node (group or project). Slices are present only
 * when managed. Later cycles extend this with their own slices.
 */
export interface NodeConfig {
  kind: NodeKind;
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
  pushRules?: PushRulesConfig;
  approvalRules?: ApprovalRuleConfig[];
  approvalSettings?: ApprovalSettings;
  variables?: VariableConfig[];
  webhooks?: WebhookConfig[];
  baselines?: BaselineConfig[];
}

/** Top-level governance config: the declared nodes, keyed by full path. */
export interface GovernanceConfig {
  nodes: Record<string, NodeConfig>;
}
