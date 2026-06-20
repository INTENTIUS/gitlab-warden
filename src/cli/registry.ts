/**
 * Cycle registry — maps `--cycles` names to their implementations.
 *
 * Cycles add themselves here as they land (see the roadmap epic). The key MUST
 * equal `cycle.name` so `--cycles` resolution and run output agree.
 */

import type { Cycle } from "../reconcile/runner.js";
import { groupSettingsCycle } from "../cycles/group-settings.js";
import { projectSettingsCycle } from "../cycles/project-settings.js";
import { membersCycle } from "../cycles/members.js";
import { protectedBranchesCycle } from "../cycles/protected-branches.js";
import { pushRulesCycle } from "../cycles/push-rules.js";
import { ciVariablesCycle } from "../cycles/ci-variables.js";
import { webhooksCycle } from "../cycles/webhooks.js";
import { baselineCycle } from "../cycles/baseline.js";
import { mrApprovalsCycle } from "../cycles/mr-approvals.js";
import { protectedTagsCycle } from "../cycles/protected-tags.js";
import { protectedEnvironmentsCycle } from "../cycles/protected-environments.js";
import { deployKeysTokensCycle } from "../cycles/deploy-keys-tokens.js";
import { integrationsCycle } from "../cycles/integrations.js";

export const CYCLE_REGISTRY: Record<string, Cycle> = {
  [protectedTagsCycle.name]: protectedTagsCycle,
  [protectedEnvironmentsCycle.name]: protectedEnvironmentsCycle,
  [deployKeysTokensCycle.name]: deployKeysTokensCycle,
  [integrationsCycle.name]: integrationsCycle,
  [groupSettingsCycle.name]: groupSettingsCycle,
  [projectSettingsCycle.name]: projectSettingsCycle,
  [membersCycle.name]: membersCycle,
  [protectedBranchesCycle.name]: protectedBranchesCycle,
  [pushRulesCycle.name]: pushRulesCycle,
  [ciVariablesCycle.name]: ciVariablesCycle,
  [webhooksCycle.name]: webhooksCycle,
  [baselineCycle.name]: baselineCycle,
  [mrApprovalsCycle.name]: mrApprovalsCycle,
};
