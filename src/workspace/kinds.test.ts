import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

// The forge-governance member kind (INTENTIUS/chant#3180): a data-only kinds
// file chant reads at the package's ./workspace-kinds subpath, and a JSON
// Schema that chant checks the member's governance file against (WSP012).

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (rel: string): any => JSON.parse(readFileSync(join(root, rel), "utf-8"));

const pkg = readJson("package.json");
const kinds = readJson("workspace-kinds.json");
const kind = kinds.kinds[0];
const schema = readJson(kind.memberFile.schema);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

// chant's own schema for a kinds file, as published at its
// ./workspace/*.schema.json subpath. memberFile needs chant 0.124.48 and
// graph.reader 0.124.49; an older chant drops the kind with WSP002.
const kindsSchemaPath = createRequire(import.meta.url).resolve("@intentius/chant/workspace/workspace-kinds.schema.json");
const validateKinds = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(kindsSchemaPath, "utf-8")));

const sample = parseYaml(`
nodes:
  acme/platform:
    kind: group
    groupSettings: { description: "Platform team", visibility: private }
    members:
      - { user: alice, accessLevel: owner }
    pushRules: { preventSecrets: true }
  acme/platform/api:
    kind: project
    projectSettings: { mergeMethod: ff, topics: [go, service] }
    protectedBranches:
      - { name: main, pushAccessLevel: 40, mergeAccessLevel: 30 }
`);

describe("forge-governance kinds file", () => {
  test("declares one kind, with the fields chant reads", () => {
    expect(kinds.schema).toBe(1);
    expect(kinds.kinds).toHaveLength(1);
    expect(kind.name).toBe("forge-governance");
    expect(kind.precedence).toBeGreaterThan(0);
    expect(kind.precedence).toBeLessThan(500);
    expect(kind.outputs).toEqual(["repos", "teams"]);
    expect(kind.graph.reader).toBe("dist/graph-reader.mjs");
  });

  test("names the drift reader chant workspace drift runs (chant 0.124.96)", () => {
    expect(kind.drift).toEqual({ reader: "dist/drift-reader.mjs", config: { dir: "{dir}", file: "governance.yml" } });
    expect(pkg.scripts["build:drift"]).toContain("--outfile=dist/drift-reader.mjs");
    expect(pkg.scripts.build).toContain("npm run build:drift");
  });

  test("passes chant's workspace-kinds schema", () => {
    expect(validateKinds(kinds), JSON.stringify(validateKinds.errors)).toBe(true);
  });

  test("checks governance.yml and probes for it and the older governance.yaml", () => {
    expect(kind.memberFile.path).toBe("governance.yml");
    expect(kind.graph.config.file).toBe("governance.yml");
    expect(kind.probe).toEqual({ anyFile: ["governance.yml", "governance.yaml"] });
  });

  test("is exported and shipped by the package", () => {
    expect(pkg.exports["./workspace-kinds"]).toBe("./workspace-kinds.json");
    expect(pkg.files).toContain("workspace-kinds.json");
    expect(pkg.files).toContain("schemas");
  });
});

describe("forge-governance member file schema", () => {
  test("accepts the sample policy", () => {
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
  });

  test("refuses a policy without its top-level map", () => {
    expect(validate({})).toBe(false);
  });

  test("refuses a misspelled field", () => {
    const bad = structuredClone(sample) as any;
    const top = bad.orgs ?? bad.nodes;
    const first = top[Object.keys(top)[0]];
    first.settngs = {};
    expect(validate(bad)).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain("settngs");
  });
});
