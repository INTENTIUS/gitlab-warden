/**
 * Where the governance policy lives (INTENTIUS/gitlab-warden#71).
 *
 * The policy file is `governance.yml`, the name forgejo-warden and
 * github-warden read. `governance.yaml` is still read, with a deprecation
 * note on stderr: when the `.yml` file is asked for (by default or by name)
 * and only the `.yaml` sits beside it, and when `--config` names
 * `governance.yaml` itself. Any other path is read as given.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const POLICY_FILE = "governance.yml";
export const LEGACY_POLICY_FILE = "governance.yaml";

export interface PolicyPath {
  path: string;
  /** The file is `governance.yaml`; the caller prints `deprecationNote(path)`. */
  deprecated: boolean;
}

/**
 * Resolve the policy path. `given` is `--config` (or the graph config's file
 * joined to the member's directory); without it, `governance.yml` in the
 * working directory. Returns undefined when nothing was given and neither
 * file exists, so the caller can say so.
 */
export function resolvePolicyPath(given: string | undefined, exists: (p: string) => boolean = existsSync): PolicyPath | undefined {
  const path = given ?? POLICY_FILE;
  if (basename(path) === POLICY_FILE && !exists(path)) {
    const legacy = join(dirname(path), LEGACY_POLICY_FILE);
    if (exists(legacy)) return { path: legacy, deprecated: true };
    if (given === undefined) return undefined;
  }
  return { path, deprecated: basename(path) === LEGACY_POLICY_FILE };
}

export function deprecationNote(path: string): string {
  return `gitlab-warden: note: ${path} is deprecated; rename it to ${POLICY_FILE}, the name gitlab-warden reads first\n`;
}
