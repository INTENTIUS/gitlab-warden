/**
 * Shared cycle helpers.
 */

// Imported from chant directly (not via ../reconcile/runner.js, which itself
// imports this module for the gated-slice notes) to keep imports acyclic.
import type { RateBudget } from "@intentius/chant/reconcile";
import { BudgetExhaustedError } from "@intentius/chant/reconcile";

/** True when the error message looks like an HTTP 404. */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

/** True when the error looks like an HTTP 403 (tier-gated / forbidden). */
export function isForbidden(err: unknown): boolean {
  return err instanceof Error && /\b403\b/.test(err.message);
}

/**
 * True when a GraphQL error says the queried field is absent from the schema —
 * GitLab CE/FOSS builds lack EE-licensed fields entirely (e.g.
 * "Field 'complianceFrameworks' doesn't exist on type 'Group'"), so tier-gated
 * GraphQL reads must tolerate this the way REST reads tolerate a 403.
 */
export function isMissingGraphQlField(err: unknown): boolean {
  return err instanceof Error && /doesn'?t exist on type/i.test(err.message);
}

/**
 * Charge one budget unit, throwing `BudgetExhaustedError` first if drained.
 * The runner converts that into deferred work rather than a failure.
 */
export function charge(budget: RateBudget, n = 1): void {
  if (budget.exhausted) throw new BudgetExhaustedError();
  budget.use(n);
}

// ---------------------------------------------------------------------------
// Tier-gate plan notes
// ---------------------------------------------------------------------------

/** One tier-gated read, recorded by a cycle's fetchLive for the plan output. */
export interface GatedSliceNote {
  /** Cycle name (matches `cycle.name` / the run result's `name`). */
  cycle: string;
  /** Kind-prefixed scope id the gated read was for. */
  scopeId: string;
  /** The config slice whose read was gated, e.g. "approvalRules". */
  slice: string;
}

const gatedSliceNotes: GatedSliceNote[] = [];

/**
 * Record that a slice's read was tier-gated (403, or the GraphQL missing-field
 * analog on CE/FOSS) and yielded no live state. The runner drains these after
 * the run and appends a NOTE line to the owning cycle's plan, so an optimistic
 * plan (creates for a slice the token can't even read) is flagged instead of
 * silent. Module-level on purpose: reconcile runs are sequential per process.
 */
export function noteGatedSlice(cycle: string, scopeId: string, slice: string): void {
  gatedSliceNotes.push({ cycle, scopeId, slice });
}

/** Drain (return and clear) all recorded gated-slice notes. */
export function drainGatedSliceNotes(): GatedSliceNote[] {
  return gatedSliceNotes.splice(0);
}
