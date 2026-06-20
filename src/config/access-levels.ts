/**
 * GitLab access-level name ↔ number mapping (see DESIGN.md §2).
 */

import type { AccessLevel, AccessLevelName } from "./types.js";

export const ACCESS_LEVELS: Record<AccessLevelName, number> = {
  no_access: 0,
  minimal: 5,
  guest: 10,
  planner: 15,
  reporter: 20,
  developer: 30,
  maintainer: 40,
  owner: 50,
};

const BY_NUMBER: Record<number, AccessLevelName> = Object.fromEntries(
  Object.entries(ACCESS_LEVELS).map(([name, n]) => [n, name as AccessLevelName]),
) as Record<number, AccessLevelName>;

/** Resolve a named-or-numeric access level to its GitLab number. */
export function toAccessNumber(level: AccessLevel): number {
  if (typeof level === "number") return level;
  const n = ACCESS_LEVELS[level];
  if (n === undefined) throw new Error(`unknown access level: ${level}`);
  return n;
}

/** Map a GitLab access number back to its name (or the number as string if unknown). */
export function fromAccessNumber(n: number): string {
  return BY_NUMBER[n] ?? String(n);
}
