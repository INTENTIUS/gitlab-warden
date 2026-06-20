/**
 * Shared cycle helpers.
 */

import type { RateBudget } from "../reconcile/runner.js";
import { BudgetExhaustedError } from "../reconcile/runner.js";

/** True when the error message looks like an HTTP 404. */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

/** True when the error looks like an HTTP 403 (tier-gated / forbidden). */
export function isForbidden(err: unknown): boolean {
  return err instanceof Error && /\b403\b/.test(err.message);
}

/**
 * Charge one budget unit, throwing `BudgetExhaustedError` first if drained.
 * The runner converts that into deferred work rather than a failure.
 */
export function charge(budget: RateBudget, n = 1): void {
  if (budget.exhausted) throw new BudgetExhaustedError();
  budget.use(n);
}
