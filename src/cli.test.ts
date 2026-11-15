import { describe, it, expect } from "vitest";
import { parseReconcileArgs, CliError } from "./cli.js";

describe("parseReconcileArgs", () => {
  it("leaves --config unset when it is not given (governance.yml is the default)", () => {
    expect(parseReconcileArgs([]).config).toBeUndefined();
  });

  it("defaults mode to dry-run and token env to GITLAB_TOKEN", () => {
    const a = parseReconcileArgs(["--config", "g.yaml"]);
    expect(a).toMatchObject({ config: "g.yaml", mode: "dry-run", tokenEnv: "GITLAB_TOKEN", cycles: [] });
  });

  it("parses all flags", () => {
    const a = parseReconcileArgs([
      "--config", "g.yaml",
      "--mode", "apply",
      "--cycles", "group-settings, members",
      "--base-url", "https://gitlab.example.com",
      "--token-env", "CI_TOKEN",
      "--allow-guardrail-override",
    ]);
    expect(a).toMatchObject({
      mode: "apply",
      cycles: ["group-settings", "members"],
      baseUrl: "https://gitlab.example.com",
      tokenEnv: "CI_TOKEN",
      allowGuardrailOverride: true,
    });
  });

  it("parses --plan-json and --member, refusing --plan-json with --mode apply and --member without --plan-json", () => {
    const a = parseReconcileArgs([]);
    expect(a.planJson).toBeUndefined();
    expect(a.member).toBeUndefined();
    const b = parseReconcileArgs(["--plan-json", "plan.json", "--member", "gov"]);
    expect(b.planJson).toBe("plan.json");
    expect(b.member).toBe("gov");
    const bad = (argv: string[]) => expect(() => parseReconcileArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad(["--plan-json"]);
    bad(["--plan-json", "plan.json", "--member"]);
    bad(["--mode", "apply", "--plan-json", "plan.json"]);
    bad(["--member", "gov"]);
    bad(["--plan-json", "plan.json", "--member", ""]);
  });

  it("rejects an unknown flag, bad mode, and missing value", () => {
    expect(() => parseReconcileArgs(["--config", "g", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseReconcileArgs(["--config", "g", "--mode", "yolo"])).toThrow(/--mode must be/);
    expect(() => parseReconcileArgs(["--config"])).toThrow(/--config requires a value/);
  });

  it("--config-mode defaults to fold and takes fold, run or check, as in forgejo-warden", () => {
    expect(parseReconcileArgs([]).configMode).toBe("fold");
    for (const m of ["fold", "run", "check"] as const) {
      expect(parseReconcileArgs(["--config", "governance.ts", "--config-mode", m]).configMode).toBe(m);
    }
    expect(() => parseReconcileArgs(["--config-mode", "eval"])).toThrow(/--config-mode must be "fold", "run" or "check", got: eval/);
    expect(() => parseReconcileArgs(["--config-mode"])).toThrow(/got: \(missing\)/);
    try {
      parseReconcileArgs(["--config-mode", "eval"]);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(2);
    }
  });

  it("parses --removal-cap-fraction and validates the (0, 1] range at exit 2", () => {
    expect(parseReconcileArgs(["--config", "g", "--removal-cap-fraction", "0.5"]).removalCapFraction).toBe(0.5);
    expect(parseReconcileArgs(["--config", "g", "--removal-cap-fraction", "1"]).removalCapFraction).toBe(1);
    expect(parseReconcileArgs(["--config", "g"]).removalCapFraction).toBeUndefined();
    for (const bad of ["0", "-0.5", "1.5", "abc", "NaN"]) {
      let err: unknown;
      try {
        parseReconcileArgs(["--config", "g", "--removal-cap-fraction", bad]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(2);
      expect((err as CliError).message).toMatch(/--removal-cap-fraction must be a number in \(0, 1\]/);
    }
    expect(() => parseReconcileArgs(["--config", "g", "--removal-cap-fraction"])).toThrow(/requires a value/);
  });

  it("base URL stays optional (defaults to gitlab.com downstream)", () => {
    const a = parseReconcileArgs(["--config", "g.yaml"]);
    expect(a.baseUrl).toBeUndefined();
    expect(a.baseUrlEnv).toBeUndefined();
  });
});
