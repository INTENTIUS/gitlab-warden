/**
 * Live-state snapshot types.
 *
 * Each mirrors a desired-config slice (`config/types.ts`) with concrete values.
 * Where GitLab addresses a resource by numeric id (members by user id, webhooks
 * + approval rules by id), the id is carried here so the apply path can target
 * it — it is never diffed.
 */

import type { Visibility } from "../config/types.js";

export interface LiveGroupSettings {
  name?: string;
  description?: string;
  visibility?: Visibility;
  requestAccessEnabled?: boolean;
  projectCreationLevel?: string;
  subgroupCreationLevel?: string;
  preventForkingOutsideGroup?: boolean;
  mentionsDisabled?: boolean;
}

export interface LiveProjectSettings {
  description?: string;
  visibility?: Visibility;
  defaultBranch?: string;
  mergeMethod?: string;
  squashOption?: string;
  onlyAllowMergeIfPipelineSucceeds?: boolean;
  onlyAllowMergeIfAllDiscussionsAreResolved?: boolean;
  removeSourceBranchAfterMerge?: boolean;
  topics?: string[];
}

/** A direct member (see DESIGN.md — inherited members are never represented here). */
export interface LiveMember {
  /** Numeric user id (used by the apply path; never diffed). */
  userId: number;
  /** Username, for keying/reporting. */
  username: string;
  accessLevel: number;
  memberRoleId?: number;
  expiresAt?: string;
}

export interface LiveProtectedBranch {
  name: string;
  pushAccessLevel?: number;
  mergeAccessLevel?: number;
  unprotectAccessLevel?: number;
  allowForcePush?: boolean;
  codeOwnerApprovalRequired?: boolean;
}

export interface LiveProtectedTag {
  name: string;
  createAccessLevel?: number;
}

export interface LiveProtectedEnvironment {
  name: string;
  deployAccessLevels?: number[];
  requiredApprovalCount?: number;
}

export interface LiveDeployKey {
  /** Deploy key id (apply path; never diffed). */
  id?: number;
  title: string;
  canPush?: boolean;
}

export interface LiveDeployToken {
  /** Deploy token id (apply path; never diffed). */
  id?: number;
  name: string;
  scopes?: string[];
  expiresAt?: string;
  username?: string;
}

export interface LivePushRules {
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

export interface LiveApprovalRule {
  /** Rule id (apply path; never diffed). */
  id?: number;
  name: string;
  approvalsRequired?: number;
  userIds?: number[];
  groupIds?: number[];
  protectedBranchIds?: number[];
}

export interface LiveApprovalSettings {
  resetApprovalsOnPush?: boolean;
  disableOverridingApproversPerMergeRequest?: boolean;
  mergeRequestsAuthorApproval?: boolean;
  mergeRequestsDisableCommittersApproval?: boolean;
  requirePasswordToApprove?: boolean;
}

export interface LiveVariable {
  key: string;
  value?: string;
  environmentScope?: string;
  protected?: boolean;
  masked?: boolean;
  variableType?: string;
}

export interface LiveWebhook {
  /** Hook id (apply path; never diffed). */
  id?: number;
  url: string;
  pushEvents?: boolean;
  mergeRequestsEvents?: boolean;
  tagPushEvents?: boolean;
  issuesEvents?: boolean;
  pipelineEvents?: boolean;
  enableSslVerification?: boolean;
}

/** Live snapshot of a single node's state (group or project). */
export interface LiveNodeState {
  groupSettings?: LiveGroupSettings;
  projectSettings?: LiveProjectSettings;
  members?: LiveMember[];
  protectedBranches?: LiveProtectedBranch[];
  protectedTags?: LiveProtectedTag[];
  protectedEnvironments?: LiveProtectedEnvironment[];
  deployKeys?: LiveDeployKey[];
  deployTokens?: LiveDeployToken[];
  pushRules?: LivePushRules;
  approvalRules?: LiveApprovalRule[];
  approvalSettings?: LiveApprovalSettings;
  variables?: LiveVariable[];
  webhooks?: LiveWebhook[];
  /** Names of existing children (for baseline provisioning). */
  children?: string[];
}
