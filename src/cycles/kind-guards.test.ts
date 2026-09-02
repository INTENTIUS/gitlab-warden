/**
 * POLICY.md promises: "A slice declared on a node kind its cycle doesn't cover
 * is ignored (the cycle no-ops on that kind)." The group/project cycles must
 * therefore no-op on `instance` nodes: fetchLive makes no API calls and
 * buildDesired drops the slice (so no entries are ever planned or applied).
 */

import { describe, it, expect } from "vitest";
import type { Cycle } from "../reconcile/runner.js";
import type { NodeConfig } from "../config/types.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { membersCycle } from "./members.js";
import { pushRulesCycle } from "./push-rules.js";
import { ciVariablesCycle } from "./ci-variables.js";
import { webhooksCycle } from "./webhooks.js";
import { integrationsCycle } from "./integrations.js";
import { protectedEnvironmentsCycle } from "./protected-environments.js";
import { deployKeysTokensCycle } from "./deploy-keys-tokens.js";
import { accessTokensCycle } from "./access-tokens.js";
import { securityPoliciesCycle } from "./security-policies.js";

const INSTANCE = "instance:gitlab.example.com";

/** An instance node that (wrongly) declares every group/project slice. */
const instanceConfig: NodeConfig = {
  kind: "instance",
  members: [{ user: "alice", accessLevel: "owner" }],
  pushRules: { preventSecrets: true },
  variables: [{ key: "K", value: "v" }],
  webhooks: [{ url: "https://h" }],
  integrations: [{ name: "slack" }],
  protectedEnvironments: [{ name: "prod" }],
  deployKeys: [{ title: "k", key: "ssh-ed25519 AAAA" }],
  deployTokens: [{ name: "t" }],
  accessTokens: [{ name: "bot" }],
  securityPolicy: { policyProject: "acme/policies" },
};

const cycles: Array<{ cycle: Cycle<Record<string, never>>; slices: Array<keyof NodeConfig> }> = [
  { cycle: membersCycle as Cycle<Record<string, never>>, slices: ["members"] },
  { cycle: pushRulesCycle as Cycle<Record<string, never>>, slices: ["pushRules"] },
  { cycle: ciVariablesCycle as Cycle<Record<string, never>>, slices: ["variables"] },
  { cycle: webhooksCycle as Cycle<Record<string, never>>, slices: ["webhooks"] },
  { cycle: integrationsCycle as Cycle<Record<string, never>>, slices: ["integrations"] },
  { cycle: protectedEnvironmentsCycle as Cycle<Record<string, never>>, slices: ["protectedEnvironments"] },
  { cycle: deployKeysTokensCycle as Cycle<Record<string, never>>, slices: ["deployKeys", "deployTokens"] },
  { cycle: accessTokensCycle as Cycle<Record<string, never>>, slices: ["accessTokens"] },
  { cycle: securityPoliciesCycle as Cycle<Record<string, never>>, slices: ["securityPolicy"] },
];

describe("group/project cycles no-op on instance nodes", () => {
  for (const { cycle, slices } of cycles) {
    it(`${cycle.name}: fetchLive makes no calls and buildDesired drops ${slices.join("/")}`, async () => {
      const client = makeClient();
      const live = await cycle.fetchLive(client, INSTANCE, {}, makeBudget());
      expect(live).toEqual({});
      expect(client.calls).toEqual([]);

      const desired = cycle.buildDesired(instanceConfig, INSTANCE, {});
      expect(desired.kind).toBe("instance");
      for (const slice of slices) expect(desired[slice]).toBeUndefined();
    });
  }
});
