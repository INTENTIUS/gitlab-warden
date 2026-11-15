#!/usr/bin/env node
/**
 * gitlab-warden — governance reconcile CLI.
 *
 * Subcommands:
 *   reconcile   Load config, build an authed client, run selected cycles.
 *               `--plan-json <file>` also writes the plan as a chant
 *               change-set part; `--drift-issue` keeps one GitLab issue
 *               tracking the drift a dry run finds.
 *   repos       Write the policy's group's project list in the format
 *               `chant workspace check --forge-repos` reads.
 *   migrate     Translate GitHub Actions workflows into GitLab CI YAML.
 *
 * Auth is a GitLab API token; the instance host defaults to gitlab.com and is
 * overridable for self-managed:
 *   --base-url <url> | --base-url-env <VAR>     GitLab instance URL (default https://gitlab.com)
 *   --token-env <VAR>                           env var holding the API token
 *
 * Exit codes: 0 success · 1 guardrail block (reconcile apply) or --strict
 *             diagnostic failure (migrate) · 2 arg/config error ·
 *             3 runtime error.
 */

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { createClient, DEFAULT_BASE_URL } from "./auth/client.js";
import { forgeRepoList, pickGroup, policyGroups } from "./repos.js";
import { runReconcile, type Cycle } from "./reconcile/runner.js";
import { defaultMemberName, planPart } from "./reconcile/plan-part.js";
import { driftRecords } from "./drift/reader.js";
import {
  describeDriftIssue,
  driftIssueEnvironment,
  driftIssueForge,
  driftIssueProject,
  driftIssueRunUrl,
  isProjectRef,
  keepGovernanceDriftIssue,
  policyRoots,
} from "./drift/issue.js";
import { CYCLE_REGISTRY } from "./cli/registry.js";
import { CliError } from "./cli-error.js";
import { parseMigrateArgs } from "./migrate/args.js";
import { runMigrate } from "./migrate/migrate.js";
import type { GovernanceConfig } from "./config/types.js";
import { deprecationNote, resolvePolicyPath } from "./config/policy-path.js";
import { loadGovernancePolicy, type ConfigMode } from "./config/load.js";
import type { PolicyProvenance } from "./reconcile/origin.js";
import pkg from "../package.json" with { type: "json" };

/** Inlined from package.json at build time — always matches the published version. */
const VERSION: string = pkg.version;

export { CliError } from "./cli-error.js";

export interface ReconcileArgs {
  /** `--config`; undefined reads governance.yml (or governance.yaml) in the working directory. */
  config: string | undefined;
  /** How a `.ts` policy is evaluated: folded without running (default), imported, or both and compared. */
  configMode: ConfigMode;
  mode: "dry-run" | "apply";
  cycles: string[];
  baseUrl: string | undefined;
  baseUrlEnv: string | undefined;
  tokenEnv: string;
  allowGuardrailOverride: boolean;
  /** Max deletable fraction per resource type, in (0,1]. Default 0.25 downstream. */
  removalCapFraction: number | undefined;
  /** File to write the run's plan to, as a chant change-set part. */
  planJson: string | undefined;
  /** The workspace member the part and the drift records name; undefined defaults to the policy directory's name. */
  member: string | undefined;
  /** Keep one GitLab issue tracking the drift this dry run finds (`keepDriftIssue`). */
  driftIssue: boolean;
  /** The project the drift issue lives in (full path or id); undefined reads CI_PROJECT_PATH. */
  driftIssueRepo: string | undefined;
}

const KNOWN_FLAGS = new Set([
  "--config",
  "--config-mode",
  "--mode",
  "--cycles",
  "--base-url",
  "--base-url-env",
  "--token-env",
  "--allow-guardrail-override",
  "--removal-cap-fraction",
  "--plan-json",
  "--member",
  "--drift-issue",
  "--drift-issue-repo",
]);

/** Parse reconcile argv. Pure: throws `CliError` (with exit code) on bad input. */
export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    config: undefined,
    configMode: "fold",
    mode: "dry-run",
    cycles: [],
    baseUrl: undefined,
    baseUrlEnv: undefined,
    tokenEnv: "GITLAB_TOKEN",
    allowGuardrailOverride: false,
    removalCapFraction: undefined,
    planJson: undefined,
    member: undefined,
    driftIssue: false,
    driftIssueRepo: undefined,
  };

  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new CliError(2, `${flag} requires a value`);
    return v;
  };

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new CliError(2, `unexpected positional argument: ${flag}`);
    if (!KNOWN_FLAGS.has(flag)) throw new CliError(2, `unknown flag: ${flag}`);
    switch (flag) {
      case "--config":
        args.config = need(++i, flag);
        break;
      case "--config-mode": {
        const v = argv[++i];
        if (v !== "fold" && v !== "run" && v !== "check") throw new CliError(2, `--config-mode must be "fold", "run" or "check", got: ${v ?? "(missing)"}`);
        args.configMode = v;
        break;
      }
      case "--mode": {
        const v = argv[++i];
        if (v !== "dry-run" && v !== "apply") throw new CliError(2, `--mode must be "dry-run" or "apply", got: ${v ?? "(missing)"}`);
        args.mode = v;
        break;
      }
      case "--cycles":
        args.cycles = need(++i, flag).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--base-url":
        args.baseUrl = need(++i, flag);
        break;
      case "--base-url-env":
        args.baseUrlEnv = need(++i, flag);
        break;
      case "--token-env":
        args.tokenEnv = need(++i, flag);
        break;
      case "--allow-guardrail-override":
        args.allowGuardrailOverride = true;
        break;
      case "--removal-cap-fraction": {
        const v = need(++i, flag);
        const f = Number(v);
        // Same (0,1] contract chant's removalDeltaCap enforces — validated
        // here so a typo is a clean exit 2, not a mid-run throw.
        if (!Number.isFinite(f) || f <= 0 || f > 1) {
          throw new CliError(2, `--removal-cap-fraction must be a number in (0, 1], got: ${v}`);
        }
        args.removalCapFraction = f;
        break;
      }
      case "--plan-json":
        args.planJson = need(++i, flag);
        break;
      case "--member":
        args.member = need(++i, flag);
        if (args.member.trim() === "") throw new CliError(2, "--member requires a non-empty name");
        break;
      case "--drift-issue":
        args.driftIssue = true;
        break;
      case "--drift-issue-repo":
        args.driftIssueRepo = need(++i, flag);
        if (!isProjectRef(args.driftIssueRepo)) throw new CliError(2, `--drift-issue-repo must be a project's full path (group/project) or id, got: ${args.driftIssueRepo}`);
        break;
    }
    i++;
  }

  if (args.planJson !== undefined && args.mode === "apply") {
    throw new CliError(2, "--plan-json writes a plan without applying it; it cannot be combined with --mode apply");
  }
  if (args.member !== undefined && args.planJson === undefined && !args.driftIssue) {
    throw new CliError(2, "--member names the member of the --plan-json part or the drift records; give it with --plan-json or --drift-issue");
  }
  if (args.driftIssue && args.mode === "apply") {
    throw new CliError(2, "--drift-issue tracks the drift a dry run finds; it cannot be combined with --mode apply");
  }
  if (args.driftIssue && args.cycles.length > 0) {
    throw new CliError(2, "--drift-issue tracks the whole policy's drift; it cannot be combined with --cycles, whose run would read the other cycles' nodes as matching");
  }
  if (args.driftIssueRepo !== undefined && !args.driftIssue) {
    throw new CliError(2, "--drift-issue-repo names the project of the drift issue; give it with --drift-issue");
  }

  return args;
}

export interface ReposArgs {
  /** `--config`; undefined reads governance.yml (or governance.yaml, then governance.ts) in the working directory. */
  config: string | undefined;
  configMode: ConfigMode;
  /** The group to list (`--group`, or `--org` as in the other wardens); undefined means the policy's only top-level group. */
  group: string | undefined;
  /** File to write; undefined writes to stdout. */
  out: string | undefined;
  baseUrl: string | undefined;
  baseUrlEnv: string | undefined;
  tokenEnv: string;
}

const REPOS_FLAGS = new Set(["--config", "--config-mode", "--group", "--org", "--out", "--base-url", "--base-url-env", "--token-env"]);

/** Parse `repos` argv. Pure: throws `CliError` (with exit code) on bad input. */
export function parseReposArgs(argv: string[]): ReposArgs {
  const args: ReposArgs = {
    config: undefined,
    configMode: "fold",
    group: undefined,
    out: undefined,
    baseUrl: undefined,
    baseUrlEnv: undefined,
    tokenEnv: "GITLAB_TOKEN",
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--") || v === "") throw new CliError(2, `${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new CliError(2, `unexpected positional argument: ${flag}`);
    if (!REPOS_FLAGS.has(flag)) throw new CliError(2, `unknown flag for repos: ${flag}`);
    switch (flag) {
      case "--config":
        args.config = need(++i, flag);
        break;
      case "--config-mode": {
        const v = argv[++i];
        if (v !== "fold" && v !== "run" && v !== "check") throw new CliError(2, `--config-mode must be "fold", "run" or "check", got: ${v ?? "(missing)"}`);
        args.configMode = v;
        break;
      }
      case "--group":
      case "--org": {
        const v = need(++i, flag);
        if (args.group !== undefined && args.group !== v) throw new CliError(2, "--group and --org name the same group; give one");
        args.group = v;
        break;
      }
      case "--out":
        args.out = need(++i, flag);
        break;
      case "--base-url":
        args.baseUrl = need(++i, flag);
        break;
      case "--base-url-env":
        args.baseUrlEnv = need(++i, flag);
        break;
      case "--token-env":
        args.tokenEnv = need(++i, flag);
        break;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) die(2, `env var ${name} is not set or is empty`);
  return v;
}

function die(code: number, message: string): never {
  process.stderr.write(`gitlab-warden: error: ${message}\n`);
  process.exit(code);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runReconcileCommand(argv: string[]): Promise<void> {
  let args: ReconcileArgs;
  try {
    args = parseReconcileArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }

  const policy = resolvePolicyPath(args.config);
  if (!policy) die(2, "no --config given and no governance.yml (or governance.ts) in the working directory");
  if (policy.deprecated) process.stderr.write(deprecationNote(policy.path));

  let config: GovernanceConfig;
  let provenance: PolicyProvenance | undefined;
  try {
    ({ config, provenance } = await loadGovernancePolicy(policy.path, args.configMode));
  } catch (err) {
    die(2, `invalid governance config "${policy.path}": ${errMsg(err)}`);
  }

  let member: string | undefined;
  if (args.planJson !== undefined || args.driftIssue) {
    member = args.member ?? defaultMemberName(policy.path);
    if (!member) die(2, `cannot name the ${args.planJson !== undefined ? "--plan-json" : "--drift-issue"} member from "${policy.path}"'s directory; give --member <name>`);
  }
  let issueProject: string | undefined;
  if (args.driftIssue) {
    issueProject = driftIssueProject(args.driftIssueRepo);
    if (!issueProject) {
      die(2, "--drift-issue needs the project to keep the issue in: give --drift-issue-repo <group/project>, or run in GitLab CI where CI_PROJECT_PATH is set");
    }
    if (!isProjectRef(issueProject)) die(2, `the drift issue project must be a full path (group/project) or id, got: ${issueProject}`);
  }

  const baseUrl = args.baseUrl ?? (args.baseUrlEnv ? env(args.baseUrlEnv) : undefined);
  const token = env(args.tokenEnv);
  const client = createClient({ baseUrl, token });

  let cycles: Cycle[];
  if (args.cycles.length === 0) {
    cycles = Object.values(CYCLE_REGISTRY);
  } else {
    cycles = [];
    for (const name of args.cycles) {
      const cycle = CYCLE_REGISTRY[name];
      if (!cycle) die(2, `unknown cycle: "${name}". Known cycles: ${Object.keys(CYCLE_REGISTRY).join(", ") || "(none yet)"}`);
      cycles.push(cycle);
    }
  }

  let result;
  try {
    result = await runReconcile({
      config,
      client,
      cycles,
      mode: args.mode,
      allowGuardrailOverride: args.allowGuardrailOverride,
      removalDeltaCapFraction: args.removalCapFraction,
      provenance,
    });
  } catch (err) {
    die(3, `reconcile failed: ${errMsg(err)}`);
  }

  if (args.planJson !== undefined) {
    const part = planPart({ member: member!, changeSets: result.changeSets, errored: result.errored, deferred: result.deferred });
    try {
      writeFileSync(args.planJson, `${JSON.stringify(part, null, 2)}\n`, "utf-8");
    } catch (err) {
      die(3, `failed to write plan to "${args.planJson}": ${errMsg(err)}`);
    }
  }

  for (const cr of result.cycles) {
    process.stdout.write(`\n=== ${cr.name} @ ${cr.org} ===\n${cr.plan}\n`);
    if (cr.guardrailBlocked) {
      const diags = cr.guardrails.ok ? [] : cr.guardrails.diagnostics;
      process.stdout.write(`\nGUARDRAIL BLOCK: ${diags.map((d) => d.message).join("; ")}\n`);
    }
    if (args.mode === "apply" && !cr.guardrailBlocked) {
      process.stdout.write(`Applied: ${cr.applied.length}, Failed: ${cr.failed.length}\n`);
      for (const f of cr.failed) process.stdout.write(`  FAILED [${f.entry.resourceType}] ${f.entry.key}: ${f.error}\n`);
    }
  }
  for (const ce of result.errored) process.stderr.write(`ERROR in ${ce.name} @ ${ce.org} (${ce.stage}): ${ce.error}\n`);
  if (result.deferred.skippedCycles.length > 0) {
    process.stderr.write(`DEFERRED (budget): ${result.deferred.skippedCycles.join(", ")}\n`);
  }

  let driftIssueFailed = false;
  if (args.driftIssue) {
    const observedAt = new Date().toISOString();
    const records = driftRecords({ member: member!, observedAt, changeSets: result.changeSets, errored: result.errored, deferred: result.deferred, policy: config });
    const instance = baseUrl ?? DEFAULT_BASE_URL;
    const runUrl = driftIssueRunUrl();
    try {
      const forge = driftIssueForge({ baseUrl: instance, project: issueProject!, token, tokenEnv: args.tokenEnv, ...(runUrl ? { runUrl } : {}) });
      const kept = await keepGovernanceDriftIssue(forge, {
        environment: driftIssueEnvironment(instance, policyRoots(config)),
        records,
        observedAt,
        ...(runUrl ? { runUrl } : {}),
      });
      process.stdout.write(`\n${describeDriftIssue(kept)}\n`);
    } catch (err) {
      driftIssueFailed = true;
      process.stderr.write(`gitlab-warden: error: keeping the drift issue failed: ${errMsg(err)}\n`);
    }
  }

  if (result.cycles.some((cr) => cr.guardrailBlocked)) process.exit(1);
  if (driftIssueFailed || result.errored.length > 0 || result.cycles.some((cr) => cr.failed.length > 0)) process.exit(3);
  process.exit(0);
}

async function runReposCommand(argv: string[]): Promise<void> {
  let args: ReposArgs;
  try {
    args = parseReposArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }

  const policy = resolvePolicyPath(args.config);
  if (!policy) die(2, "no --config given and no governance.yml (or governance.ts) in the working directory");
  if (policy.deprecated) process.stderr.write(deprecationNote(policy.path));

  let config: GovernanceConfig;
  try {
    ({ config } = await loadGovernancePolicy(policy.path, args.configMode));
  } catch (err) {
    die(2, `invalid governance config "${policy.path}": ${errMsg(err)}`);
  }

  let group: string;
  try {
    group = pickGroup(policyGroups(config), args.group);
  } catch (err) {
    die(2, errMsg(err));
  }

  const baseUrl = args.baseUrl ?? (args.baseUrlEnv ? env(args.baseUrlEnv) : DEFAULT_BASE_URL);
  const token = env(args.tokenEnv);
  const client = createClient({ baseUrl, token });

  let text: string;
  try {
    text = `${JSON.stringify(await forgeRepoList(client, group, baseUrl), null, 2)}\n`;
  } catch (err) {
    die(3, `listing the repositories of ${group} failed: ${errMsg(err)}`);
  }
  if (args.out === undefined) {
    process.stdout.write(text);
  } else {
    try {
      writeFileSync(args.out, text, "utf-8");
    } catch (err) {
      die(3, `failed to write the repository list to "${args.out}": ${errMsg(err)}`);
    }
  }
  process.exit(0);
}

async function runMigrateCommand(argv: string[]): Promise<void> {
  let outcome;
  try {
    outcome = await runMigrate(parseMigrateArgs(argv));
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    die(3, `migrate failed: ${errMsg(err)}`);
  }
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  process.exit(outcome.exitCode);
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: gitlab-warden <subcommand> [flags]",
      "",
      "Subcommands:",
      "  reconcile [--config <path>] [flags] Reconcile governance policy against live GitLab.",
      "  repos [flags]                        Write the policy's group's project list for chant --forge-repos.",
      "  migrate <path> [flags]               Translate GitHub Actions workflows to GitLab CI.",
      "",
      "Reconcile flags:",
      "  --config <path>               Governance config: YAML, JSON, or a .ts policy (default governance.yml; then governance.yaml, then governance.ts).",
      "  --config-mode fold|run|check  How a .ts policy is evaluated (default: fold).",
      "  --mode dry-run|apply          Reconcile mode (default: dry-run).",
      "  --cycles <name[,name...]>     Cycles to run (default: all).",
      "  --base-url <url>              GitLab instance URL (default https://gitlab.com; or --base-url-env <VAR>).",
      "  --token-env <VAR>             Env var holding the API token (default GITLAB_TOKEN).",
      "  --allow-guardrail-override    Apply even when guardrails trip.",
      "  --removal-cap-fraction <f>    Max deletable fraction of each resource type's live entries, in (0, 1] (default 0.25).",
      "  --plan-json <file>            Write the plan as a chant change-set part (dry-run only).",
      "  --member <name>               Member the part and the drift records name (default: the policy file's directory name).",
      "  --drift-issue                 Keep one forge issue tracking the drift this dry run finds (dry-run only).",
      "  --drift-issue-repo <path>     Project the issue lives in (default: CI_PROJECT_PATH).",
      "",
      "repos writes the policy's group's repository list, archived repos and the",
      "subgroups' projects included, as the JSON `chant workspace check --forge-repos <file>` reads.",
      "",
      "Repos flags:",
      "  --config <path>               Governance config, read as for reconcile (default governance.yml).",
      "  --config-mode fold|run|check  How a .ts policy is evaluated (default: fold).",
      "  --group <path>                Group to list (default: the policy's only top-level group; --org also works).",
      "  --out <file>                  File to write (default: stdout).",
      "  --base-url <url>              GitLab instance URL (default https://gitlab.com; or --base-url-env <VAR>).",
      "  --token-env <VAR>             Env var holding the API token (default GITLAB_TOKEN).",
      "",
      "Migrate flags:",
      "  <path>                        One workflow file, or a directory (.github/workflows/).",
      "  -o, --output <path>           Output file (single input) or directory (directory input).",
      "  --emit yaml|ts                Output format (default yaml).",
      "  --strict                      Exit 1 on any error-severity diagnostic.",
      "  --report <file>               Write SARIF v2.1.0 findings.",
      "  --use-composites              Rewrite eligible jobs to chant composites.",
      "  --stitch / --no-stitch        Directory mode: emit a root .gitlab-ci.yml of includes (default on).",
      "",
      "Exit codes: 0 success · 1 guardrail block / --strict findings · 2 arg/config error · 3 runtime error.",
      "",
    ].join("\n"),
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const sub = argv[0];
  if (!sub || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  if (sub === "--version" || sub === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (sub === "reconcile") {
    await runReconcileCommand(argv.slice(1));
    return;
  }
  if (sub === "repos") {
    await runReposCommand(argv.slice(1));
    return;
  }
  if (sub === "migrate") {
    await runMigrateCommand(argv.slice(1));
    return;
  }
  die(2, `unknown subcommand: ${sub}. Known subcommands: reconcile, repos, migrate.`);
}

export async function run(argv: string[]): Promise<void> {
  await main(argv);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`gitlab-warden: fatal: ${errMsg(err)}\n`);
    process.exit(3);
  });
}
