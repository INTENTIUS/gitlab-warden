/**
 * `reconcile --plan-json`: the run's plan as a part of a chant change-set
 * document (`@intentius/chant/change-set`, chant#3181).
 *
 * chant's `reconcilePlanPart` turns the reconcile change sets into the part;
 * chant reads the file back with `readChangeSetPartFile(part, "warden",
 * member, lexicon)` and composes it with the other members' parts.
 *
 * The flag name, the `--member` default and the part's shape are shared by
 * the three wardens (chant#5069); only the lexicon label differs. Each
 * entry's scope is the kind-prefixed scope id the cycles run under
 * (`group:acme/platform`, `project:acme/platform/api`).
 *
 * Each entry's address is its graph node id, or `<node id>#<resourceType>[<key>]`
 * for a change under that node (`planEntryAddress`, INTENTIUS/chant#5089), so
 * the part's entries sit on the same `forge-governance` graph nodes as the
 * drift reader's records.
 */

import { basename, dirname, resolve } from "node:path";
import { reconcilePlanPart, type ChangeSetPart } from "@intentius/chant/change-set";
import type { ChangeSet, ChangeSetEntry, CycleError, DeferredWork } from "@intentius/chant/reconcile";
import type { GovernanceConfig } from "../config/types.js";
import { planEntryAddress, scopeNode } from "../drift/reader.js";

/** The lexicon label a gitlab-warden part carries on its member and entries. */
export const PLAN_PART_LEXICON = "gitlab";

/**
 * The member name `--member` defaults to: the name of the directory the
 * policy file sits in, which is the member's directory in a chant workspace.
 * Undefined when that directory has no name (the filesystem root).
 */
export function defaultMemberName(configPath: string): string | undefined {
  const name = basename(dirname(resolve(configPath)));
  return name === "" ? undefined : name;
}

export interface PlanPartInput {
  member: string;
  /** The policy the run reconciled, for the declared node each change set's scope stands for. */
  policy: GovernanceConfig;
  /** Every change set the run diffed, one per cycle and scope. */
  changeSets: ChangeSet[];
  /** Cycles that failed before they could plan. */
  errored?: CycleError[];
  /** Cycles the request budget skipped. */
  deferred?: DeferredWork;
}

/** The change sets with every entry's address stamped from the node it falls under. */
export function addressChangeSets(policy: GovernanceConfig, changeSets: readonly ChangeSet[]): ChangeSet[] {
  return changeSets.map((cs) => {
    const { kind, path } = scopeNode(policy, cs.org);
    const entries: ChangeSetEntry[] = cs.entries.map((e) => ({ ...e, address: planEntryAddress(kind, path, e) }));
    return { ...cs, entries };
  });
}

/**
 * The part for one reconcile run. A run where every cycle planned gives a
 * `planned` member whose digest covers the change sets. When a cycle errored
 * or the budget skipped one, the plan is incomplete, so the member is
 * `failed` with no plan digest (no gate can bind it) and an `error` naming
 * what is missing; the entries the other cycles planned stay in the part.
 */
export function planPart(input: PlanPartInput): ChangeSetPart {
  const part = reconcilePlanPart({ member: input.member, plan: addressChangeSets(input.policy, input.changeSets), lexicon: PLAN_PART_LEXICON });
  const missing = [
    ...(input.errored ?? []).map((e) => `${e.name} @ ${e.org} errored in ${e.stage}: ${e.error}`),
    ...(input.deferred?.skippedCycles ?? []).map((c) => `${c} was deferred by the request budget`),
  ];
  if (missing.length === 0) return part;
  return {
    ...part,
    member: { ...part.member, status: "failed", planDigest: null, error: missing.join("; ") },
  };
}
