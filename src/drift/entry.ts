/**
 * The module a `drift.reader` in workspace-kinds.json names
 * (INTENTIUS/chant#5068). `chant workspace drift --member` imports it in its
 * own process and calls the default export with the member's directory, the
 * kind's config, the member's name and the time to stamp; it answers with
 * the drift stream lines of one reconcile dry run, or a refusal.
 */

import type { DriftReaderInput, DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import { readGovernanceDrift } from "./reader.js";

export default function read(input: DriftReaderInput): Promise<DriftReaderOutput> {
  return readGovernanceDrift(input);
}
