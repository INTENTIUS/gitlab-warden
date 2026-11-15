/**
 * The module a `graph.reader` in workspace-kinds.json names (INTENTIUS/chant#4413).
 * chant's `graph` loads it in a reader project and calls it with the member's
 * directory; it reads the governance file there and returns graph IR. A member
 * that still has only governance.yaml is read with a deprecation note on stderr.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { deprecationNote, POLICY_FILE, resolvePolicyPath } from "../config/policy-path.js";
import { readGovernance, type GraphIR } from "./reader.js";

export default function read(input: { dir: string; config: { file?: string } }): GraphIR {
  const policy = resolvePolicyPath(join(input.dir, input.config.file ?? POLICY_FILE))!;
  const file = relative(input.dir, policy.path);
  if (policy.deprecated) process.stderr.write(deprecationNote(file));
  return readGovernance(parse(readFileSync(policy.path, "utf-8")), file);
}
