/**
 * Cycle registry — maps `--cycles` names to their implementations.
 *
 * Cycles add themselves here as they land (see the roadmap epic). The key MUST
 * equal `cycle.name` so `--cycles` resolution and run output agree.
 */

import type { Cycle } from "../reconcile/runner.js";

export const CYCLE_REGISTRY: Record<string, Cycle> = {};
