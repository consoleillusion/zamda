// latest(): the abort handling an interactive page needs. Each new run cancels
// the one still in flight, so a slider that fires ten times does one query's
// worth of work and only the newest result arrives.

import type { Table } from './backend';
import type { ParamDecls } from './pipe';
import type { ExecuteArgs, Plan } from './plan';
import type { Result } from './result';
import type { Fields } from './schema';

export type LatestRun<In extends Fields, Out extends Fields, P extends ParamDecls> = (
  table: Table<In>,
  ...args: ExecuteArgs<P>
) => Promise<Result<Out>>;

export function latest<In extends Fields, Out extends Fields, P extends ParamDecls>(
  plan: Plan<In, Out, P>,
): LatestRun<In, Out, P> {
  // Purpose: wrap a plan so that starting a run aborts the previous one, which rejects with AbortError
  let current: AbortController | null = null;
  return function run(table, ...args) {
    // Purpose: abort the run in flight, then start a new one
    if (current) current.abort();
    const controller = new AbortController();
    current = controller;
    const options = args[0] ?? {};
    const outer = options.signal;
    if (outer) {
      // The caller's own signal still cancels the run.
      if (outer.aborted) controller.abort();
      else {
        outer.addEventListener(
          'abort',
          function () {
            controller.abort();
          },
          { once: true },
        );
      }
    }
    const merged = [{ ...options, signal: controller.signal }] as unknown as ExecuteArgs<P>;
    return plan.execute(table, ...merged);
  };
}
