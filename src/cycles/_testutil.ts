/**
 * Shared test scaffolding for cycle tests — a recording mock client and a
 * countable budget. Not a test file (no `*.test` suffix), so vitest skips it.
 */

import type { GitLabClient } from "../auth/client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { BudgetExhaustedError } from "../reconcile/runner.js";

export interface MockCall {
  method: string;
  path: string;
  body?: unknown;
}
export interface MockClient extends GitLabClient {
  calls: MockCall[];
}

/**
 * A mock client.
 * - `responses` maps `"METHOD /path"` → value (or a function of the body) for
 *   `request()`. Unmapped routes return `{}`. Map to a throwing function to
 *   simulate an error.
 * - `pages` maps a path → array for `paginate()`. Unmapped → `[]`.
 */
export function makeClient(
  responses: Record<string, unknown | ((body: unknown) => unknown)> = {},
  pages: Record<string, unknown[]> = {},
): MockClient {
  const calls: MockCall[] = [];
  const rmap = new Map(Object.entries(responses));
  const pmap = new Map(Object.entries(pages));
  return {
    calls,
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const hit = rmap.get(`${method} ${path}`);
      const val = typeof hit === "function" ? (hit as (b: unknown) => unknown)(body) : hit;
      return (val === undefined ? {} : val) as T;
    },
    async paginate<T = unknown>(path: string): Promise<T[]> {
      calls.push({ method: "PAGINATE", path });
      return (pmap.get(path) ?? []) as T[];
    },
  };
}

export function makeBudget(n = 1000): RateBudget {
  let r = n;
  return {
    get remaining() {
      return r;
    },
    get exhausted() {
      return r <= 0;
    },
    use(k = 1) {
      if (r <= 0) throw new BudgetExhaustedError();
      r = Math.max(0, r - k);
    },
  };
}
