/**
 * The module a `drift.reader` in workspace-kinds.json names
 * (INTENTIUS/chant#5068). `chant workspace drift --member <name>` imports it
 * in its own process and calls the default export with the member's
 * directory and the kind's `drift.config`; it reads the policy there, runs a
 * dry-run reconcile against GitLab and returns the drift stream
 * (`./reader.ts`).
 *
 * Credentials come from the environment, as for `gitlab-warden reconcile`
 * with its defaults: the token from `GITLAB_TOKEN`, the instance from
 * `GITLAB_BASE_URL` when set, else https://gitlab.com. A `drift.config` may
 * name other variables with `tokenEnv` and `baseUrlEnv`. A missing token or
 * policy is a refusal (`no-drift-read`), never a throw.
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { DriftReaderInput, DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import { createClient, DEFAULT_BASE_URL, type GitLabClient } from "../auth/client.js";
import { CYCLE_REGISTRY } from "../cli/registry.js";
import { loadGovernancePolicy } from "../config/load.js";
import { deprecationNote, POLICY_FILE, resolvePolicyPath } from "../config/policy-path.js";
import { readGovernanceDrift } from "./reader.js";
import pkg from "../../package.json" with { type: "json" };

export const DEFAULT_TOKEN_ENV = "GITLAB_TOKEN";
export const DEFAULT_BASE_URL_ENV = "GITLAB_BASE_URL";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export interface DriftEntryDeps {
  env?: NodeJS.ProcessEnv;
  /** Build the client; tests pass a mock. */
  client?: (opts: { baseUrl: string; token: string }) => GitLabClient;
}

/** The reader with its environment and client injectable, for tests. */
export async function readMemberDrift(input: DriftReaderInput, deps: DriftEntryDeps = {}): Promise<DriftReaderOutput> {
  const env = deps.env ?? process.env;
  if (input.read !== undefined && input.read !== "live-read") {
    return { refused: { code: "read-unsupported", message: `gitlab-warden reads drift with a live read of GitLab (live-read), not ${input.read}` } };
  }
  if (input.stack !== undefined) {
    return { refused: { code: "read-unsupported", message: "gitlab-warden has no stacks; read the member without --stack" } };
  }

  const file = str(input.config.file) ?? POLICY_FILE;
  const policy = resolvePolicyPath(join(input.dir, file));
  if (!policy || !existsSync(policy.path)) {
    return { refused: { code: "no-drift-read", message: `no ${file} in ${input.dir}, so there is no policy to read drift for` } };
  }
  if (policy.deprecated) process.stderr.write(deprecationNote(relative(input.dir, policy.path)));

  const tokenEnv = str(input.config.tokenEnv) ?? DEFAULT_TOKEN_ENV;
  const token = env[tokenEnv];
  if (!token) {
    return { refused: { code: "no-drift-read", message: `${tokenEnv} is not set, so gitlab-warden cannot read GitLab for ${input.member}` } };
  }
  const baseUrl = env[str(input.config.baseUrlEnv) ?? DEFAULT_BASE_URL_ENV] || DEFAULT_BASE_URL;

  const { config } = await loadGovernancePolicy(policy.path);
  const client = (deps.client ?? ((o) => createClient(o)))({ baseUrl, token });
  return readGovernanceDrift({
    config,
    client,
    cycles: Object.values(CYCLE_REGISTRY),
    member: input.member,
    observedAt: input.observedAt,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    version: pkg.version,
  });
}

export default function readDrift(input: DriftReaderInput): Promise<DriftReaderOutput> {
  return readMemberDrift(input);
}
