// The same policy as governance.yml, as data in TypeScript. The type gives
// completion and a compile error on a misspelt key; the preset is the part
// YAML cannot express without anchors. By default warden folds this file to
// its value without running it (--config-mode fold); it is typed JSON.
import type { GovernanceConfig } from "@intentius/gitlab-warden";

// One review policy, several settings. When a field it sets drifts, the plan
// names the argument it came from and the line that argument is on.
const reviewPreset = (review: { approvals: number; linear: boolean }) => ({
  projectSettings: {
    mergeMethod: review.linear ? "ff" : "merge",
    squashOption: review.linear ? ("always" as const) : ("default_off" as const),
    onlyAllowMergeIfPipelineSucceeds: true,
    removeSourceBranchAfterMerge: true,
  },
  protectedBranches: [{ name: "main", pushAccessLevel: 0, mergeAccessLevel: 40, allowForcePush: false }],
  approvalRules: [{ name: "review", approvalsRequired: review.approvals }],
});

const api = reviewPreset({ approvals: 2, linear: true });
const web = reviewPreset({ approvals: 1, linear: false });

export default {
  nodes: {
    acme: {
      kind: "group",
      groupSettings: { description: "Engineering", visibility: "private" },
    },
    "acme/api": {
      kind: "project",
      ...api,
      projectSettings: { ...api.projectSettings, topics: ["service", "api"] },
    },
    "acme/web": {
      kind: "project",
      ...web,
      projectSettings: { ...web.projectSettings, topics: ["service", "web"] },
    },
  },
} satisfies GovernanceConfig;
