#!/usr/bin/env node
/**
 * gitlab-warden — governance reconcile CLI.
 *
 * Subcommand:
 *   reconcile   Load config, build an authed client, run selected cycles.
 *
 * Auth is a GitLab API token; the instance host defaults to gitlab.com and is
 * overridable for self-managed:
 *   --base-url <url> | --base-url-env <VAR>     GitLab instance URL (default https://gitlab.com)
 *   --token-env <VAR>                           env var holding the API token
 *
 * Exit codes: 0 success · 1 guardrail block (apply) · 2 arg/config error ·
 *             3 runtime error.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { createClient } from "./auth/client.js";
import { runReconcile, type Cycle } from "./reconcile/runner.js";
import { CYCLE_REGISTRY } from "./cli/registry.js";
import type { GovernanceConfig } from "./config/types.js";

export class CliError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface ReconcileArgs {
  config: string;
  mode: "dry-run" | "apply";
  cycles: string[];
  baseUrl: string | undefined;
  baseUrlEnv: string | undefined;
  tokenEnv: string;
  allowGuardrailOverride: boolean;
}

const KNOWN_FLAGS = new Set([
  "--config",
  "--mode",
  "--cycles",
  "--base-url",
  "--base-url-env",
  "--token-env",
  "--allow-guardrail-override",
]);

/** Parse reconcile argv. Pure: throws `CliError` (with exit code) on bad input. */
export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    config: "",
    mode: "dry-run",
    cycles: [],
    baseUrl: undefined,
    baseUrlEnv: undefined,
    tokenEnv: "GITLAB_TOKEN",
    allowGuardrailOverride: false,
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
    }
    i++;
  }

  if (!args.config) throw new CliError(2, "--config is required");
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

function loadConfig(path: string): GovernanceConfig {
  const text = readFileSync(path, "utf-8");
  const raw = path.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  if (!raw || typeof raw !== "object" || typeof (raw as { nodes?: unknown }).nodes !== "object") {
    throw new Error("config must be an object with a `nodes` map");
  }
  return raw as GovernanceConfig;
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

  let config: GovernanceConfig;
  try {
    config = loadConfig(args.config);
  } catch (err) {
    die(2, `invalid governance config "${args.config}": ${errMsg(err)}`);
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
    result = await runReconcile({ config, client, cycles, mode: args.mode, allowGuardrailOverride: args.allowGuardrailOverride });
  } catch (err) {
    die(3, `reconcile failed: ${errMsg(err)}`);
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

  if (result.cycles.some((cr) => cr.guardrailBlocked)) process.exit(1);
  if (result.errored.length > 0 || result.cycles.some((cr) => cr.failed.length > 0)) process.exit(3);
  process.exit(0);
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: gitlab-warden reconcile [flags]",
      "",
      "Flags:",
      "  --config <path>               Governance config (YAML or JSON). Required.",
      "  --mode dry-run|apply          Reconcile mode (default: dry-run).",
      "  --cycles <name[,name...]>     Cycles to run (default: all).",
      "  --base-url <url>              GitLab instance URL (default https://gitlab.com; or --base-url-env <VAR>).",
      "  --token-env <VAR>             Env var holding the API token (default GITLAB_TOKEN).",
      "  --allow-guardrail-override    Apply even when guardrails trip.",
      "",
      "Exit codes: 0 success · 1 guardrail block · 2 arg/config error · 3 runtime error.",
      "",
    ].join("\n"),
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    process.exit(0);
  }
  if (sub === "--version" || sub === "-v") {
    process.stdout.write("0.1.0\n");
    process.exit(0);
  }
  if (sub === "reconcile") {
    await runReconcileCommand(argv.slice(1));
    return;
  }
  die(2, `unknown subcommand: ${sub}. Did you mean "reconcile"?`);
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
