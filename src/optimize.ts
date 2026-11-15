// IR-to-IR optimization passes. They run before validation, so every backend
// benefits and no pass can smuggle an invalid plan through.
//
// No passes exist yet. Planned, in order (docs/TASKS.md, T-203):
//   1. constant folding
//   2. filter and project fusion
//   3. projection pushdown
//   4. limit pushdown
// A pass must never change results; the golden suite runs with passes on and off.

import type { IrPlan } from './ir';

export type Pass = (plan: IrPlan) => IrPlan;

export const PASSES: readonly Pass[] = [];

export function optimize(plan: IrPlan): IrPlan {
  // Purpose: run every optimization pass in order
  let current = plan;
  for (const pass of PASSES) current = pass(current);
  return current;
}
