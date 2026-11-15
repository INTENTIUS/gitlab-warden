/**
 * `reconcile --drift-issue`: one GitLab issue tracking the governance drift
 * a dry run finds (INTENTIUS/gitlab-warden#75), shaped as forgejo-warden's
 * (forgejo-warden#47).
 *
 * chant's `keepDriftIssue` (`@intentius/chant/drift-issue`) does the work:
 * it opens the issue when the run finds drift, updates it when the drift
 * changes, leaves it alone when the drift is the same or the read was
 * incomplete, and closes it when GitLab matches the policy again. The
 * records are the drift reader's (`./reader.ts`), so the issue and
 * `chant workspace drift` report the same thing: a node with planned
 * changes is `drifted`, which is drift under keepDriftIssue's default
 * statuses.
 */

import { keepDriftIssue, type DriftIssueResult, type DriftIssueWords } from "@intentius/chant/drift-issue";
import type { DriftRecord } from "@intentius/chant/drift-record";
import { forgeClient, type ForgeFetch, type PrForge } from "@intentius/chant/pr-forge";
import type { GovernanceConfig } from "../config/types.js";

/** The product name on the marker and the fingerprint. */
export const DRIFT_ISSUE_PRODUCT = "gitlab-warden";

type Env = Record<string, string | undefined>;

/** A GitLab project by full path (`group/project`, subgroups allowed) or numeric id. */
export const isProjectRef = (v: string): boolean => /^\d+$/.test(v) || /^[^/\s]+(\/[^/\s]+)+$/.test(v);

/** The project the issue lives in: the flag, else GitLab CI's `CI_PROJECT_PATH`. Undefined when neither is set. */
export function driftIssueProject(flag: string | undefined, env: Env = process.env): string | undefined {
  return flag ?? (env.CI_PROJECT_PATH?.trim() || undefined);
}

/** The pipeline's URL in GitLab CI, when the job says it. */
export function driftIssueRunUrl(env: Env = process.env): string | undefined {
  return env.CI_PIPELINE_URL?.trim() || undefined;
}

/**
 * The policy's top-level paths: each group or project node no declared group
 * contains (an instance-only policy gives its instance nodes). The drift
 * issue's environment names them.
 */
export function policyRoots(config: GovernanceConfig): string[] {
  const entries = Object.entries(config.nodes ?? {});
  const groups = entries.filter(([, n]) => n.kind === "group").map(([p]) => p);
  const roots = entries
    .filter(([, n]) => n.kind === "group" || n.kind === "project")
    .map(([p]) => p)
    .filter((p) => !groups.some((g) => p.startsWith(`${g}/`)));
  return roots.length > 0 ? roots : entries.map(([p]) => p);
}

/** What the issue is for: the instance's host and the policy's top-level paths, `gitlab.com/acme`. Keys the marker. */
export function driftIssueEnvironment(baseUrl: string, roots: readonly string[]): string {
  return `${new URL(baseUrl).host.toLowerCase()}/${[...roots].sort().join(",")}`;
}

/** gitlab-warden's words for its drift issue. */
export const DRIFT_ISSUE_WORDS: DriftIssueWords = {
  product: DRIFT_ISSUE_PRODUCT,
  title: (facts) => `Governance drift on ${facts.environment}`,
  values: { before: "declared", after: "live" },
  advice: () =>
    "Run `gitlab-warden reconcile --mode apply` to bring GitLab back to the policy, or change the policy to match. This issue closes on the first dry run that finds no drift.",
};

export interface DriftIssueForgeOptions {
  /** The GitLab instance the warden governs; the issue's project is on it. */
  baseUrl: string;
  /** The project's full path or numeric id. */
  project: string;
  token: string;
  /** The variable the token came from, for messages. */
  tokenEnv: string;
  runUrl?: string;
  fetch?: ForgeFetch;
}

/** chant's GitLab client for the issue's project, with the warden's own token. */
export function driftIssueForge(opts: DriftIssueForgeOptions): PrForge {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return forgeClient(
    {
      kind: "gitlab",
      apiBase: `${base}/api/v4`,
      repo: opts.project,
      host: new URL(base).host.toLowerCase(),
      token: opts.token,
      tokenSource: opts.tokenEnv,
      tokenHeader: "PRIVATE-TOKEN",
      ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    },
    opts.fetch,
  );
}

export interface KeepGovernanceDriftIssueInput {
  environment: string;
  records: readonly DriftRecord[];
  runUrl?: string;
  observedAt?: string;
}

/** Bring the environment's one drift issue in line with the run. Throws what the forge throws. */
export function keepGovernanceDriftIssue(forge: Pick<PrForge, "trackIssue">, input: KeepGovernanceDriftIssueInput): Promise<DriftIssueResult> {
  return keepDriftIssue(forge, {
    words: DRIFT_ISSUE_WORDS,
    environment: input.environment,
    records: input.records,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
  });
}

/** One line for the job log: `Drift issue: opened #4 <url>`. */
export function describeDriftIssue(r: DriftIssueResult): string {
  return [`Drift issue: ${r.action}`, r.number !== undefined ? `#${r.number}` : "", r.url ?? "", r.why ? `(${r.why})` : ""].filter(Boolean).join(" ");
}
