import { describe, expect, it } from "vitest";
import { deprecationNote, resolvePolicyPath } from "./policy-path.js";

const only = (...files: string[]) => (p: string) => files.includes(p);

describe("resolvePolicyPath", () => {
  it("defaults to governance.yml", () => {
    expect(resolvePolicyPath(undefined, only("governance.yml", "governance.yaml"))).toEqual({ path: "governance.yml", deprecated: false });
  });

  it("falls back to governance.yaml, marked deprecated, when there is no governance.yml", () => {
    expect(resolvePolicyPath(undefined, only("governance.yaml"))).toEqual({ path: "governance.yaml", deprecated: true });
    expect(resolvePolicyPath("policy/governance.yml", only("policy/governance.yaml"))).toEqual({ path: "policy/governance.yaml", deprecated: true });
  });

  it("finds nothing when no path is given and neither file exists", () => {
    expect(resolvePolicyPath(undefined, only())).toBeUndefined();
  });

  it("reads a named governance.yaml, marked deprecated", () => {
    expect(resolvePolicyPath("governance.yaml", only("governance.yaml"))).toEqual({ path: "governance.yaml", deprecated: true });
  });

  it("reads any other path as given, even when it is missing", () => {
    expect(resolvePolicyPath("org/policy.json", only())).toEqual({ path: "org/policy.json", deprecated: false });
    expect(resolvePolicyPath("governance.yml", only())).toEqual({ path: "governance.yml", deprecated: false });
  });

  it("the note names the file and the rename", () => {
    expect(deprecationNote("governance.yaml")).toBe(
      "gitlab-warden: note: governance.yaml is deprecated; rename it to governance.yml, the name gitlab-warden reads first\n",
    );
  });
});
