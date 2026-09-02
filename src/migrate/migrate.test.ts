/**
 * Migrate subcommand tests.
 *
 * Fixture-driven, mirroring chant's approach: each `fixtures/<name>/` holds an
 * `input.yml` (GitHub Actions workflow) and `expected.gitlab-ci.yml`; the
 * fixtures copied from the gitlab lexicon's own suite pin warden's single-file
 * output to what `chant migrate` produces for the same input. Directory mode,
 * stitching, `--strict`, SARIF, and the schedule hint are covered on top.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseMigrateArgs } from "./args.js";
import { runMigrate, extractSchedules, renderScheduleHint, renderStitchedRoot } from "./migrate.js";
import { CliError } from "../cli-error.js";

const FIXTURES = join(__dirname, "fixtures");

/** Parse YAML ignoring the generated-by banner comment. */
function canonical(text: string): unknown {
  return parseYaml(text.replace(/^#[^\n]*\n+/g, ""));
}

describe("parseMigrateArgs", () => {
  it("requires a path", () => {
    expect(() => parseMigrateArgs([])).toThrow(CliError);
    expect(() => parseMigrateArgs([])).toThrow(/requires a workflow file or directory/);
  });

  it("defaults: yaml emit, stitch on, no strict", () => {
    const a = parseMigrateArgs(["wf.yml"]);
    expect(a).toMatchObject({ input: "wf.yml", emit: "yaml", strict: false, stitch: true, useComposites: false });
    expect(a.output).toBeUndefined();
    expect(a.report).toBeUndefined();
  });

  it("parses all flags", () => {
    const a = parseMigrateArgs([
      ".github/workflows",
      "-o", "out",
      "--emit", "ts",
      "--strict",
      "--report", "findings.sarif",
      "--use-composites",
      "--no-stitch",
    ]);
    expect(a).toMatchObject({
      input: ".github/workflows",
      output: "out",
      emit: "ts",
      strict: true,
      report: "findings.sarif",
      useComposites: true,
      stitch: false,
    });
  });

  it("rejects unknown flags, bad emit, missing values, extra positionals", () => {
    expect(() => parseMigrateArgs(["wf.yml", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseMigrateArgs(["wf.yml", "--emit", "json"])).toThrow(/--emit must be/);
    expect(() => parseMigrateArgs(["wf.yml", "--output"])).toThrow(/requires a value/);
    expect(() => parseMigrateArgs(["a.yml", "b.yml"])).toThrow(/unexpected extra positional/);
  });
});

describe("fixtures: single-file output matches chant migrate", () => {
  for (const name of readdirSync(FIXTURES).sort()) {
    const dir = join(FIXTURES, name);
    if (!existsSync(join(dir, "input.yml"))) continue;
    it(name, async () => {
      const outcome = await runMigrate(parseMigrateArgs([join(dir, "input.yml")]));
      expect(outcome.exitCode).toBe(0);
      expect(canonical(outcome.stdout)).toEqual(canonical(readFileSync(join(dir, "expected.gitlab-ci.yml"), "utf-8")));
      const expectedDiag = join(dir, "expected-diagnostics.json");
      if (existsSync(expectedDiag)) {
        const want = JSON.parse(readFileSync(expectedDiag, "utf-8")) as { ruleIds: string[] };
        // Compare against the informative stderr rendering: every expected rule shows up.
        for (const rule of want.ruleIds) expect(outcome.stderr).toContain(rule);
      }
    });
  }
});

describe("runMigrate", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "warden-migrate-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const scheduleWorkflow = [
    "name: nightly",
    "on:",
    "  push:",
    "  schedule:",
    "    - cron: '0 6 * * 1'",
    "    - cron: '30 2 * * *'",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: make build",
    "",
  ].join("\n");

  it("writes to -o and keeps stdout empty", async () => {
    const src = join(tmp, "single.yml");
    const out = join(tmp, "single-out.yml");
    writeFileSync(src, scheduleWorkflow);
    const outcome = await runMigrate(parseMigrateArgs([src, "-o", out]));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(outcome.written).toContain(out);
    const emitted = parseYaml(readFileSync(out, "utf-8")) as Record<string, unknown>;
    expect(emitted["build"]).toBeDefined();
  });

  it("renders the MIG-ON-SCHEDULE hint as a pipelineSchedules policy block", async () => {
    const src = join(tmp, "sched.yml");
    writeFileSync(src, scheduleWorkflow);
    const outcome = await runMigrate(parseMigrateArgs([src]));
    expect(outcome.stderr).toContain("MIG-ON-SCHEDULE");
    expect(outcome.stderr).toContain("pipelineSchedules:");
    expect(outcome.stderr).toContain('cron: "0 6 * * 1"');
    expect(outcome.stderr).toContain('cron: "30 2 * * *"');
    expect(outcome.stderr).toContain("ref: main");
  });

  it("--strict escalates needs-review findings to exit 1", async () => {
    const src = join(tmp, "strict.yml");
    writeFileSync(src, scheduleWorkflow);
    const ok = await runMigrate(parseMigrateArgs([src]));
    expect(ok.exitCode).toBe(0);
    const strict = await runMigrate(parseMigrateArgs([src, "--strict"]));
    expect(strict.exitCode).toBe(1);
  });

  it("--report writes valid SARIF v2.1.0 with migration rule metadata", async () => {
    const src = join(tmp, "sarif.yml");
    const report = join(tmp, "findings.sarif");
    writeFileSync(src, scheduleWorkflow);
    const outcome = await runMigrate(parseMigrateArgs([src, "--report", report]));
    expect(outcome.exitCode).toBe(0);
    const sarif = JSON.parse(readFileSync(report, "utf-8"));
    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe("chant");
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results.some((r: { ruleId: string }) => r.ruleId === "MIG-ON-SCHEDULE")).toBe(true);
    expect(run.tool.driver.rules.some((r: { id: string }) => r.id === "MIG-ON-SCHEDULE")).toBe(true);
  });

  it("--emit ts emits typed chant TypeScript", async () => {
    const src = join(tmp, "ts.yml");
    writeFileSync(src, scheduleWorkflow);
    const outcome = await runMigrate(parseMigrateArgs([src, "--emit", "ts"]));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("// Migrated from");
  });

  it("--use-composites is accepted and still translates", async () => {
    const src = join(tmp, "composites.yml");
    writeFileSync(src, scheduleWorkflow);
    const outcome = await runMigrate(parseMigrateArgs([src, "--use-composites"]));
    expect(outcome.exitCode).toBe(0);
    expect(parseYaml(outcome.stdout.replace(/^#[^\n]*\n+/g, ""))).toBeTruthy();
  });

  it("rejects a missing input with exit 2", async () => {
    await expect(runMigrate(parseMigrateArgs([join(tmp, "nope.yml")]))).rejects.toMatchObject({ code: 2 });
  });

  describe("directory mode", () => {
    it("emits per-workflow files plus a stitched root", async () => {
      const inDir = join(tmp, "wf-dir");
      const outDir = join(tmp, "wf-out");
      mkdirSync(inDir, { recursive: true });
      cpSync(join(FIXTURES, "01-triggers", "input.yml"), join(inDir, "ci.yml"));
      cpSync(join(FIXTURES, "03-matrix", "input.yml"), join(inDir, "matrix.yaml"));
      const outcome = await runMigrate(parseMigrateArgs([inDir, "-o", outDir]));
      expect(outcome.exitCode).toBe(0);
      expect(existsSync(join(outDir, "ci.gitlab-ci.yml"))).toBe(true);
      expect(existsSync(join(outDir, "matrix.gitlab-ci.yml"))).toBe(true);
      const root = readFileSync(join(outDir, ".gitlab-ci.yml"), "utf-8");
      const parsed = parseYaml(root.replace(/^#[^\n]*\n+/g, "")) as { include: Array<{ local: string }> };
      expect(parsed.include.map((e) => e.local).sort()).toEqual(["ci.gitlab-ci.yml", "matrix.gitlab-ci.yml"]);
    });

    it("--no-stitch suppresses the root file", async () => {
      const inDir = join(tmp, "wf-dir2");
      const outDir = join(tmp, "wf-out2");
      mkdirSync(inDir, { recursive: true });
      cpSync(join(FIXTURES, "01-triggers", "input.yml"), join(inDir, "ci.yml"));
      const outcome = await runMigrate(parseMigrateArgs([inDir, "-o", outDir, "--no-stitch"]));
      expect(outcome.exitCode).toBe(0);
      expect(existsSync(join(outDir, "ci.gitlab-ci.yml"))).toBe(true);
      expect(existsSync(join(outDir, ".gitlab-ci.yml"))).toBe(false);
    });

    it("a per-file failure does not abort the batch (aggregate exit 3)", async () => {
      const inDir = join(tmp, "wf-dir3");
      const outDir = join(tmp, "wf-out3");
      mkdirSync(inDir, { recursive: true });
      cpSync(join(FIXTURES, "01-triggers", "input.yml"), join(inDir, "ci.yml"));
      writeFileSync(join(inDir, "broken.yml"), "{{{ not: yaml: at: all\n  - ][");
      const outcome = await runMigrate(parseMigrateArgs([inDir, "-o", outDir]));
      expect(outcome.exitCode).toBe(3);
      expect(outcome.stderr).toContain("FAILED");
      expect(outcome.stderr).toContain("broken.yml");
      expect(existsSync(join(outDir, "ci.gitlab-ci.yml"))).toBe(true);
    });

    it("rejects a directory with no workflows (exit 2)", async () => {
      const inDir = join(tmp, "wf-empty");
      mkdirSync(inDir, { recursive: true });
      cpSync(join(FIXTURES, "01-triggers", "input.yml"), join(inDir, "readme.txt"));
      await expect(runMigrate(parseMigrateArgs([inDir]))).rejects.toMatchObject({ code: 2 });
    });
  });
});

describe("schedule extraction + rendering", () => {
  it("extracts every cron entry", () => {
    const schedules = extractSchedules(
      "on:\n  schedule:\n    - cron: '0 6 * * 1'\n    - cron: '5 4 * * 0'\njobs: {}\n",
      "w.yml",
    );
    expect(schedules.map((s) => s.cron)).toEqual(["0 6 * * 1", "5 4 * * 0"]);
  });

  it("tolerates workflows without schedules and unparseable input", () => {
    expect(extractSchedules("on: push\njobs: {}\n", "w.yml")).toEqual([]);
    expect(extractSchedules("{{{", "w.yml")).toEqual([]);
  });

  it("renders one policy entry per schedule", () => {
    const hint = renderScheduleHint([
      { sourceFile: "a/ci.yml", cron: "0 6 * * 1" },
      { sourceFile: "b/nightly.yml", cron: "30 2 * * *" },
    ]);
    expect(hint).toContain('description: "migrated from ci.yml"');
    expect(hint).toContain('description: "migrated from nightly.yml"');
    expect((hint.match(/cron:/g) ?? []).length).toBe(2);
  });
});

describe("renderStitchedRoot", () => {
  it("is valid YAML with one include per file", () => {
    const parsed = parseYaml(renderStitchedRoot(["a.gitlab-ci.yml", "b.gitlab-ci.yml"]).replace(/^#[^\n]*\n+/g, "")) as {
      include: Array<{ local: string }>;
    };
    expect(parsed.include).toEqual([{ local: "a.gitlab-ci.yml" }, { local: "b.gitlab-ci.yml" }]);
  });
});
