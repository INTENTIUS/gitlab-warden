/**
 * gitlab-warden public surface.
 *
 * The provider-agnostic reconcile harness is consumed from
 * `@intentius/chant/reconcile`; it is not vendored here.
 */

// GitLab REST/GraphQL client
export { createClient, encodeId, GitLabApiError } from "./auth/client.js";
export type { GitLabClient, GitLabClientOptions } from "./auth/client.js";

// The governance policy: its types, for `satisfies GovernanceConfig` in a
// `.ts` policy, and the loader that folds, runs, or checks one.
export type * from "./config/types.js";
export { loadGovernanceConfig, loadGovernancePolicy, GovernanceConfigError } from "./config/load.js";
export type { ConfigMode, LoadedPolicy } from "./config/load.js";
// Where a drifted field was written, when the policy was folded.
export { originAt, formatOrigin, driftOrigins, annotatePlan } from "./reconcile/origin.js";
export type { FieldOrigin, SourceLocation, PolicyProvenance, DriftOrigin } from "./reconcile/origin.js";
