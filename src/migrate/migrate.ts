/**
 * `gitlab-warden migrate` — GitHub Actions → GitLab CI translation, built on
 * the chant migration transformer.
 *
 * The transformer is imported directly from the gitlab lexicon (the `/index`
 * suffix is required; it resolves through the lexicon's `"./*"` wildcard
 * export). This is the same engine `chant migrate` runs, so single-file output
 * is byte-identical to chant's, and warden adds the batch layer on top:
 * directory mode translates every workflow and stitches a root `.gitlab-ci.yml`
 * of `include: local:` entries.
 *
 * Output discipline: the translated pipeline goes to stdout (or `-o`);
 * everything human-facing (findings, remediation, the schedule hint) goes to
 * stderr, so `gitlab-warden migrate ci.yml > .gitlab-ci.yml` stays clean.
 *
 * Exit codes: 0 success · 1 `--strict` diagnostic failure · 2 argument error
 * (thrown as CliError by the parser / input checks) · 3 runtime error
 * (unreadable input, transform crash; in directory mode per-file failures are
 * collected, reported, and surfaced as a single exit 3 after the batch).
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { transform, type MigrationResult } from "@intentius/chant-lexicon-gitlab/migrate/from-github/index";
import { MIGRATION_RULES } from "@intentius/chant-lexicon-gitlab/migrate/from-github/rules";
import { formatSarif } from "@intentius/chant/cli/reporters/stylish";
import type { LintDiagnostic } from "@intentius/chant/lint/rule";
import { CliError } from "../cli-error.js";
import type { MigrateArgs } from "./args.js";
import pkg from "../../package.json" with { type: "json" };

/** Outcome of one migrate run; `cli.ts` writes the streams and exits. */
export interface MigrateOutcome {
  exitCode: 0 | 1 | 3;
  /** Pipeline YAML/TS when no `-o` was given (single-file stdout mode). */
  stdout: string;
  /** Findings, remediation, schedule hint, per-file failures. */
  stderr: string;
  /** Files written, relative to cwd (absolute where the caller passed absolute). */
  written: string[];
}

interface FileResult {
  sourceFile: string;
  result: MigrationResult;
  schedules: DroppedSchedule[];
}

interface FileFailure {
  sourceFile: string;
  error: string;
}

/** A cron schedule the translator had to drop (GitLab keeps cron out of YAML). */
export interface DroppedSchedule {
  sourceFile: string;
  cron: string;
}

// ---------------------------------------------------------------------------
// Schedule extraction + policy-block hint
// ---------------------------------------------------------------------------

/** Pull `on.schedule[].cron` out of a workflow source (best effort). */
export function extractSchedules(content: string, sourceFile: string): DroppedSchedule[] {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  // YAML 1.2 keeps `on` a string key; some loaders produce boolean true.
  const on = (doc as Record<string, unknown>)["on"] ?? (doc as Record<string, unknown>)["true"];
  if (!on || typeof on !== "object") return [];
  const schedule = (on as Record<string, unknown>)["schedule"];
  if (!Array.isArray(schedule)) return [];
  const out: DroppedSchedule[] = [];
  for (const entry of schedule) {
    if (entry && typeof entry === "object" && typeof (entry as { cron?: unknown }).cron === "string") {
      out.push({ sourceFile, cron: (entry as { cron: string }).cron });
    }
  }
  return out;
}

/**
 * Render the ready-to-paste `pipelineSchedules:` policy block for schedules the
 * translation dropped. Today it documents the manual GitLab UI step precisely;
 * once the phase 2 `pipeline-schedules` cycle lands, the same block becomes
 * governed state warden reconciles.
 */
export function renderScheduleHint(schedules: DroppedSchedule[]): string {
  const lines: string[] = [
    "",
    "MIG-ON-SCHEDULE: cron schedules do not live in .gitlab-ci.yml — GitLab keeps",
    "them in the project's CI/CD > Pipeline schedules settings. The translated",
    "workflow.rules gate on $CI_PIPELINE_SOURCE == \"schedule\", so a pipeline",
    "schedule must exist for those jobs to ever run.",
    "",
    "Ready-to-paste policy block (the upcoming pipeline-schedules cycle",
    "reconciles exactly this shape; until then, create the schedules by hand):",
    "",
    "pipelineSchedules:",
  ];
  for (const s of schedules) {
    lines.push(`  - description: "migrated from ${basename(s.sourceFile)}"`);
    lines.push(`    cron: "${s.cron}"`);
    lines.push(`    ref: main`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diagnostics rendering (stderr)
// ---------------------------------------------------------------------------

/** Remediation for the lossy rules, condensed from chant's migrate report. */
const REMEDIATION: Record<string, string> = {
  "MIG-ON-SCHEDULE": "create a pipeline schedule (Project Settings > CI/CD > Pipeline schedules); see the pipelineSchedules block below",
  "MIG-ON-DISPATCH": "convert workflow_dispatch inputs to spec:inputs (GitLab 17+) and give every input a default",
  "MIG-ON-NON-GIT": "replace issue/MR/discussion triggers with gitlab-triage on a schedule, or webhooks + an external service",
  "MIG-PERMISSIONS-001": "configure CI/CD token access at Project Settings > CI/CD > Token Access",
  "MIG-JOB-OUTPUTS": "replace GitHub job outputs with artifacts:reports:dotenv files written by the producing job",
  "MIG-NEEDS-OUTPUTS-001": "use artifacts:reports:dotenv in the producer and needs: [{ job: X, artifacts: true }] in the consumer",
  "MIG-MATRIX-INCLUDE-001": "unroll matrix.include/exclude by hand; parallel:matrix has no equivalent",
  "MIG-FAIL-FAST": "GitLab matrices are not fail-fast; wrap the matrix if fail-fast is critical",
  "MIG-RUNS-ON-NON-LINUX": "register a self-hosted runner with matching tags: for macOS/Windows jobs",
  "MIG-REUSABLE-WORKFLOW": "rewrite reusable-workflow calls as include:project: plus variables:",
  "MIG-ACTION-UNKNOWN": "no registered mapping for this marketplace action; port the step by hand",
  "MIG-PIN-LOST": "re-pin the equivalent include/image on the GitLab side",
  "MIG-SECRET-UNSCOPED": "declare the variable masked + protected in GitLab CI/CD variables",
  "MIG-INJECTION-CARRIED": "the untrusted-input injection site was translated verbatim; sanitize it on the GitLab side",
  "MIG-TRUST-BOUNDARY": "review fork/MR pipeline settings; the trigger's trust boundary shifted in translation",
};

/** Render one file's findings for stderr. */
function renderFindings(sourceFile: string, diagnostics: LintDiagnostic[]): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity as keyof typeof counts]++;
  const lines = [`${sourceFile}: ${diagnostics.length} findings (${counts.error} errors, ${counts.warning} warnings, ${counts.info} info)`];
  const remediated = new Set<string>();
  for (const d of diagnostics.filter((x) => x.severity !== "info")) {
    lines.push(`  ${d.severity} ${d.ruleId} (line ${d.line}): ${d.message}`);
    const fix = REMEDIATION[d.ruleId];
    if (fix && !remediated.has(d.ruleId)) {
      remediated.add(d.ruleId);
      lines.push(`    remediation: ${fix}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const WORKFLOW_EXT = /\.ya?ml$/i;

/** Strip the workflow extension for the per-file output name. */
function outputName(workflowFile: string, emit: "yaml" | "ts"): string {
  const base = basename(workflowFile).replace(WORKFLOW_EXT, "");
  return emit === "ts" ? `${base}.gitlab-ci.ts` : `${base}.gitlab-ci.yml`;
}

async function transformFile(path: string, args: MigrateArgs): Promise<FileResult> {
  const content = readFileSync(path, "utf-8");
  // The transformer's own YAML reader is deliberately lenient and never
  // throws, which would turn garbage input into a silently empty pipeline.
  // Gate it behind a strict parse so a broken workflow is a loud failure.
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new Error(`invalid workflow YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  if (!doc || typeof doc !== "object" || !("jobs" in (doc as Record<string, unknown>))) {
    throw new Error("not a GitHub Actions workflow (no top-level jobs: mapping)");
  }
  const result = await transform(content, {
    emit: args.emit,
    useComposites: args.useComposites,
    sourceFile: path,
    strict: args.strict,
    security: true,
  });
  return { sourceFile: path, result, schedules: extractSchedules(content, path) };
}

function writeOut(path: string, content: string, written: string[]): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
  written.push(path);
}

/**
 * The stitched root: one `include: local:` entry per translated workflow.
 *
 * The root also declares the union of every workflow's inferred stages. GitLab
 * merges top-level keys across includes with later files overriding earlier
 * ones, so two included pipelines with different `stages:` lists would clobber
 * each other and leave jobs pointing at undeclared stages; the root file's
 * `stages:` wins over every include and keeps them all valid.
 */
export function renderStitchedRoot(files: string[], stages: string[]): string {
  const lines = [
    "# Generated by gitlab-warden migrate — stitches the per-workflow pipelines.",
    "# Each included file was translated from one .github/workflows entry.",
  ];
  if (stages.length > 0) {
    lines.push("stages:");
    for (const s of stages) lines.push(`  - ${s}`);
  }
  lines.push("include:");
  for (const f of files) lines.push(`  - local: ${f}`);
  return lines.join("\n") + "\n";
}

/**
 * Run migrate. Performs real file I/O for outputs and the SARIF report, but
 * returns the stream text + exit code instead of touching process streams, so
 * tests drive it directly.
 */
export async function runMigrate(args: MigrateArgs): Promise<MigrateOutcome> {
  let stat;
  try {
    stat = statSync(args.input);
  } catch {
    throw new CliError(2, `input not found: ${args.input}`);
  }

  const written: string[] = [];
  let stderr = "";
  const allDiagnostics: LintDiagnostic[] = [];
  const results: FileResult[] = [];
  const failures: FileFailure[] = [];

  if (stat.isDirectory()) {
    const entries = readdirSync(args.input)
      .filter((f) => WORKFLOW_EXT.test(f))
      .sort();
    if (entries.length === 0) throw new CliError(2, `no workflow files (*.yml, *.yaml) in ${args.input}`);

    const outDir = args.output ?? ".";
    mkdirSync(outDir, { recursive: true });
    const perFileOutputs: string[] = [];
    const stageUnion: string[] = [];

    for (const entry of entries) {
      const path = join(args.input, entry);
      try {
        const fr = await transformFile(path, args);
        results.push(fr);
        const outFile = outputName(entry, args.emit);
        writeOut(join(outDir, outFile), fr.result.output, written);
        perFileOutputs.push(outFile);
        for (const s of fr.result.stages) if (!stageUnion.includes(s)) stageUnion.push(s);
      } catch (err) {
        failures.push({ sourceFile: path, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (args.stitch && args.emit === "yaml" && perFileOutputs.length > 0) {
      writeOut(join(outDir, ".gitlab-ci.yml"), renderStitchedRoot(perFileOutputs, stageUnion), written);
    } else if (args.stitch && args.emit === "ts" && perFileOutputs.length > 0) {
      stderr += "note: --emit ts skips the stitched root (include: local: is a YAML concept)\n";
    }
  } else {
    const fr = await transformFile(args.input, args);
    results.push(fr);
    if (args.output) writeOut(args.output, fr.result.output, written);
  }

  // Findings + remediation, per file, to stderr.
  for (const fr of results) {
    allDiagnostics.push(...fr.result.diagnostics);
    if (fr.result.diagnostics.length > 0) stderr += renderFindings(fr.sourceFile, fr.result.diagnostics);
  }
  for (const f of failures) stderr += `FAILED ${f.sourceFile}: ${f.error}\n`;

  // The MIG-ON-SCHEDULE closing hint: every schedule the translation dropped,
  // as a ready-to-paste policy block.
  const dropped = results.flatMap((r) => r.schedules);
  const scheduleFired = allDiagnostics.some((d) => d.ruleId === "MIG-ON-SCHEDULE");
  if (scheduleFired && dropped.length > 0) stderr += renderScheduleHint(dropped);

  if (args.report) {
    writeOut(args.report, formatSarif(allDiagnostics, MIGRATION_RULES, undefined, pkg.version), written);
  }

  for (const w of written) stderr += `wrote ${w}\n`;

  const stdout = !stat.isDirectory() && !args.output && results[0] ? results[0].result.output : "";

  let exitCode: 0 | 1 | 3 = 0;
  if (args.strict && allDiagnostics.some((d) => d.severity === "error")) exitCode = 1;
  if (failures.length > 0) exitCode = 3;
  return { exitCode, stdout, stderr, written };
}
