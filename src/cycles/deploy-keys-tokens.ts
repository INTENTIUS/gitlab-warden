/**
 * Deploy-keys & deploy-tokens cycle.
 *
 *   Deploy keys (project): GET/POST/PUT/DELETE /projects/:id/deploy_keys
 *     — keyed by title; can_push is the only mutable field.
 *   Deploy tokens (group + project): GET/POST/DELETE …/deploy_tokens
 *     — keyed by name; immutable (presence-only; no update).
 *
 * Token/key secrets are write-only (returned on create only).
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, DeployKeyConfig, DeployTokenConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveDeployKey, LiveDeployToken } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type DeployKeysTokensScope = Record<string, never>;

interface GlDeployKey {
  id?: number;
  title?: string;
  can_push?: boolean;
}
interface GlDeployToken {
  id?: number;
  name?: string;
  scopes?: string[];
  expires_at?: string | null;
  username?: string;
}

function mapKey(raw: GlDeployKey): LiveDeployKey {
  const k: LiveDeployKey = { title: raw.title ?? "" };
  if (typeof raw.id === "number") k.id = raw.id;
  if (typeof raw.can_push === "boolean") k.canPush = raw.can_push;
  return k;
}
function mapToken(raw: GlDeployToken): LiveDeployToken {
  const t: LiveDeployToken = { name: raw.name ?? "" };
  if (typeof raw.id === "number") t.id = raw.id;
  if (Array.isArray(raw.scopes)) t.scopes = raw.scopes;
  if (raw.expires_at) t.expiresAt = raw.expires_at;
  if (raw.username) t.username = raw.username;
  return t;
}

function tokenBase(scopeId: string): string {
  const { kind, path } = parseScope(scopeId);
  const resource = kind === "group" ? "groups" : "projects";
  return `/${resource}/${encodeId(path)}/deploy_tokens`;
}

export const deployKeysTokensCycle: Cycle<DeployKeysTokensScope> = {
  name: "deploy-keys-tokens",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: DeployKeysTokensScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    const { kind, path } = parseScope(scopeId);
    const out: LiveNodeState = {};
    if (kind === "project") {
      charge(budget);
      const keys = await client.paginate<GlDeployKey>(`/projects/${encodeId(path)}/deploy_keys`);
      out.deployKeys = keys.filter((k) => k.title).map(mapKey);
    }
    charge(budget);
    const tokens = await client.paginate<GlDeployToken>(tokenBase(scopeId));
    out.deployTokens = tokens.filter((t) => t.name).map(mapToken);
    return out;
  },

  buildDesired(config: NodeConfig): NodeConfig {
    const out: NodeConfig = { kind: config.kind };
    if (config.kind === "project" && config.deployKeys !== undefined) out.deployKeys = config.deployKeys;
    if (config.deployTokens !== undefined) out.deployTokens = config.deployTokens;
    return out;
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: DeployKeysTokensScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType === "deploy-key") {
      const { path } = parseScope(scopeId);
      const base = `/projects/${encodeId(path)}/deploy_keys`;
      if (entry.kind === "create") {
        const d = entry.after as DeployKeyConfig;
        charge(budget);
        await client.request("POST", base, { title: d.title, key: d.key, ...(d.canPush !== undefined ? { can_push: d.canPush } : {}) });
        return;
      }
      const id = (entry.before as LiveDeployKey | undefined)?.id;
      if (typeof id !== "number") throw new Error(`deploy key '${entry.key}' has no live id`);
      if (entry.kind === "update") {
        const d = entry.after as DeployKeyConfig;
        charge(budget);
        await client.request("PUT", `${base}/${id}`, { ...(d.canPush !== undefined ? { can_push: d.canPush } : {}) });
        return;
      }
      charge(budget);
      await client.request("DELETE", `${base}/${id}`);
      return;
    }

    if (entry.resourceType !== "deploy-token") return;
    const base = tokenBase(scopeId);
    if (entry.kind === "create") {
      const d = entry.after as DeployTokenConfig;
      charge(budget);
      await client.request("POST", base, {
        name: d.name,
        ...(d.scopes ? { scopes: d.scopes } : {}),
        ...(d.expiresAt ? { expires_at: d.expiresAt } : {}),
        ...(d.username ? { username: d.username } : {}),
      });
      return;
    }
    if (entry.kind === "delete") {
      const id = (entry.before as LiveDeployToken | undefined)?.id;
      if (typeof id !== "number") throw new Error(`deploy token '${entry.key}' has no live id`);
      charge(budget);
      await client.request("DELETE", `${base}/${id}`);
    }
    // tokens are immutable — no update path
  },
};
