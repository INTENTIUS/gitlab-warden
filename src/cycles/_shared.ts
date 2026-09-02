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
// Plan notes (tier gates, shadowed live entries, …)
// ---------------------------------------------------------------------------

/** One NOTE destined for a cycle's plan output, recorded during fetchLive. */
export interface PlanNote {
  /** Cycle name (matches `cycle.name` / the run result's `name`). */
  cycle: string;
  /** Kind-prefixed scope id the note is for. */
  scopeId: string;
  /** The note text (rendered as `NOTE: <message>` after the plan). */
  message: string;
}

const planNotes: PlanNote[] = [];

/**
 * Record a NOTE for a cycle's plan. The runner drains these after the run and
 * appends each as a NOTE line to the owning cycle's plan, so a caveat a
 * cycle's read discovered (a gated slice, a shadowed live entry) is flagged
 * instead of silent. Module-level on purpose: reconcile runs are sequential
 * per process.
 */
export function notePlan(cycle: string, scopeId: string, message: string): void {
  planNotes.push({ cycle, scopeId, message });
}

/**
 * Record that a slice's read was tier-gated (403, or the GraphQL
 * missing-field analog on CE/FOSS) and yielded no live state, leaving an
 * optimistic plan (creates for a slice the token can't even read).
 */
export function noteGatedSlice(cycle: string, scopeId: string, slice: string): void {
  notePlan(cycle, scopeId, `${slice}: read was tier-gated (403); planned entries may fail on apply`);
}

/** Drain (return and clear) all recorded plan notes. */
export function drainPlanNotes(): PlanNote[] {
  return planNotes.splice(0);
}
