import { describe, it, expect } from "vitest";
import { parseReconcileArgs, CliError } from "./cli.js";

describe("parseReconcileArgs", () => {
  it("requires --config", () => {
    expect(() => parseReconcileArgs([])).toThrow(CliError);
    expect(() => parseReconcileArgs([])).toThrow(/--config is required/);
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

  it("rejects an unknown flag, bad mode, and missing value", () => {
    expect(() => parseReconcileArgs(["--config", "g", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseReconcileArgs(["--config", "g", "--mode", "yolo"])).toThrow(/--mode must be/);
    expect(() => parseReconcileArgs(["--config"])).toThrow(/--config requires a value/);
  });

  it("base URL stays optional (defaults to gitlab.com downstream)", () => {
    const a = parseReconcileArgs(["--config", "g.yaml"]);
    expect(a.baseUrl).toBeUndefined();
    expect(a.baseUrlEnv).toBeUndefined();
  });
});
