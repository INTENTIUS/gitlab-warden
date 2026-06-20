/**
 * Access-tokens cycle — group/project access tokens (bot credentials).
 *
 *   fetchLive — GET /{groups|projects}/:id/access_tokens (active tokens)
 *   apply
 *     create → POST   …/access_tokens   (name, scopes, access_level, expires_at)
 *     delete → DELETE …/access_tokens/:id   (revoke owned tokens absent from config)
 *
 * Tokens are immutable — reconciled by presence (keyed by name). The token value
 * is returned on create only (write-only). Token *policy* enforcement (max
 * lifetime, who-can-create) is admin/top-group settings and out of scope here.
 */

import type { GitLabClient } from "../auth/client.js";
import { encodeId } from "../auth/client.js";
import type { NodeConfig, AccessTokenConfig } from "../config/types.js";
import { toAccessNumber } from "../config/access-levels.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { parseScope } from "../reconcile/runner.js";
import type { LiveNodeState, LiveAccessToken } from "../reconcile/live.js";
import { charge } from "./_shared.js";

export type AccessTokensScope = Record<string, never>;

interface GlAccessToken {
  id?: number;
  name?: string;
  scopes?: string[];
  access_level?: number;
  expires_at?: string | null;
  active?: boolean;
  revoked?: boolean;
}

function mapToken(raw: GlAccessToken): LiveAccessToken {
  const t: LiveAccessToken = { name: raw.name ?? "" };
  if (typeof raw.id === "number") t.id = raw.id;
  if (Array.isArray(raw.scopes)) t.scopes = raw.scopes;
  if (typeof raw.access_level === "number") t.accessLevel = raw.access_level;
  if (raw.expires_at) t.expiresAt = raw.expires_at;
  if (typeof raw.active === "boolean") t.active = raw.active;
  return t;
}

function base(scopeId: string): string {
  const { kind, path } = parseScope(scopeId);
  const resource = kind === "group" ? "groups" : "projects";
  return `/${resource}/${encodeId(path)}/access_tokens`;
}

export const accessTokensCycle: Cycle<AccessTokensScope> = {
  name: "access-tokens",

  async fetchLive(
    client: GitLabClient,
    scopeId: string,
    _scope: AccessTokensScope,
    budget: RateBudget,
  ): Promise<LiveNodeState> {
    charge(budget);
    const raw = await client.paginate<GlAccessToken>(base(scopeId));
    const accessTokens = raw
      .filter((t) => t.name && t.revoked !== true && t.active !== false)
      .map(mapToken);
    return { accessTokens };
  },

  buildDesired(config: NodeConfig): NodeConfig {
    if (!config.accessTokens) return { kind: config.kind };
    return { kind: config.kind, accessTokens: config.accessTokens };
  },

  async apply(
    client: GitLabClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: AccessTokensScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "access-token") return;
    const url = base(scopeId);
    if (entry.kind === "create") {
      const d = entry.after as AccessTokenConfig;
      charge(budget);
      await client.request("POST", url, {
        name: d.name,
        ...(d.scopes ? { scopes: d.scopes } : {}),
        ...(d.accessLevel !== undefined ? { access_level: toAccessNumber(d.accessLevel) } : {}),
        ...(d.expiresAt ? { expires_at: d.expiresAt } : {}),
      });
      return;
    }
    if (entry.kind === "delete") {
      const id = (entry.before as LiveAccessToken | undefined)?.id;
      if (typeof id !== "number") throw new Error(`access token '${entry.key}' has no live id`);
      charge(budget);
      await client.request("DELETE", `${url}/${id}`);
    }
    // tokens are immutable — no update path
  },
};
