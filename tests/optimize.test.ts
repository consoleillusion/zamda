// Tests for the compiler's IR-to-IR passes (docs/TASKS.md, T-203).
// Each pass is checked twice: once on the shape of the rewritten plan, and once
// by running the plan with passes on and off and requiring the same answer.

import { describe, expect, test } from 'bun:test';
import { ifElse, lit, pipe, schema, table, t } from '../src';
import type { IrExpr, IrNode } from '../src';

const S = schema({ x: t.int32, y: t.int32, s: t.utf8 });
const rows = [
  { x: 1, y: 9, s: 'a' },
  { x: 2, y: 8, s: 'b' },
  { x: 3, y: 7, s: 'c' },
];

function exprAt(plan: { nodes: readonly IrNode[] }, node: number, column: number): IrExpr {
  // Purpose: read one projected expression out of a compiled plan for shape assertions
  const found = plan.nodes[node];
  if (!found || found.op !== 'project') throw new Error(`no project at node ${node}`);
  const expr = found.exprs[column];
  if (!expr) throw new Error(`no expression at node ${node}, column ${column}`);
  return expr;
}

function predicateAt(plan: { nodes: readonly IrNode[] }, node: number): IrExpr {
  // Purpose: read one filter predicate out of a compiled plan for shape assertions
  const found = plan.nodes[node];
  if (!found || found.op !== 'filter') throw new Error(`no filter at node ${node}`);
  return found.predicate;
}

function limitAt(plan: { nodes: readonly IrNode[] }, node: number): number {
  // Purpose: read one limit count out of a compiled plan for shape assertions
  const found = plan.nodes[node];
  if (!found || found.op !== 'limit') throw new Error(`no limit at node ${node}`);
  return found.count;
}

describe('constant folding', () => {
  test('folds a constant expression to a literal', async () => {
    const build = () => pipe(S).select(c => ({ v: lit(1, t.int32).eq(lit(2, t.int32)).not() }));
    const opt = build().compile();
    const raw = build()._compile(false);
    expect(exprAt(raw.ir, 1, 0).kind).toBe('call');
    const folded = exprAt(opt.ir, 1, 0);
    expect(folded.kind).toBe('literal');
    expect(folded.kind === 'literal' ? folded.value : null).toBe(true);
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });

  test('folds a literal in-list', async () => {
    const build = () => pipe(S).select(c => ({ v: lit(7, t.int32).isIn([1, 7, 9]) }));
    const opt = build().compile();
    const raw = build()._compile(false);
    const folded = exprAt(opt.ir, 1, 0);
    expect(folded.kind).toBe('literal');
    expect(folded.kind === 'literal' ? folded.value : null).toBe(true);
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });

  test('a folded deciding literal does not skip a failing side', async () => {
    const build = () => pipe(S).select(c => ({
      v: lit(1, t.int32).eq(lit(2, t.int32)).and(c.x.mod(lit(0, t.int32)).eq(lit(0, t.int32))),
    }));
    const input = table(S, rows);
    for (const plan of [build().compile(), build()._compile(false)]) {
      await expect(plan.execute(input)).rejects.toThrow();
    }
  });

  test('does not fold coalesce or if_else over a failing argument', async () => {
    const builds = [
      () => pipe(S).select(c => ({ v: lit(1, t.int32).coalesce(c.x.mod(lit(0, t.int32))) })),
      () => pipe(S).select(c => ({
        v: ifElse(lit(true, t.bool), lit(1, t.int32), c.x.mod(lit(0, t.int32))),
      })),
    ];
    const input = table(S, rows);
    for (const build of builds) {
      for (const plan of [build().compile(), build()._compile(false)]) {
        await expect(plan.execute(input)).rejects.toThrow();
      }
    }
  });
});

describe('filter and project fusion', () => {
  test('fuses adjacent filters', async () => {
    const build = () => pipe(S).filter(c => c.x.gt(1)).filter(c => c.y.lt(8));
    const opt = build().compile();
    const raw = build()._compile(false);
    expect(raw.ir.nodes.length).toBe(3);
    expect(opt.ir.nodes.length).toBe(2);
    const predicate = predicateAt(opt.ir, 1);
    expect(predicate.kind === 'call' ? predicate.fn : '').toBe('and');
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });

  test('does not fuse a filter that could fail on dropped rows', () => {
    const opt = pipe(S)
      .filter(c => c.x.gt(1))
      .filter(c => c.x.mod(lit(0, t.int32)).eq(lit(0, t.int32)))
      .compile();
    expect(opt.ir.nodes.length).toBe(3);
  });

  test('fuses adjacent projects', async () => {
    const build = () => pipe(S).select(c => ({ v: c.s.lower() })).select(c => ({ w: c.v.upper() }));
    const opt = build().compile();
    const raw = build()._compile(false);
    expect(raw.ir.nodes.length).toBe(3);
    expect(opt.ir.nodes.length).toBe(2);
    const outer = exprAt(opt.ir, 1, 0);
    expect(outer.kind === 'call' ? outer.fn : '').toBe('upper');
    expect(outer.kind === 'call' && outer.args[0]!.kind === 'call' ? outer.args[0]!.fn : '').toBe('lower');
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });

  test('a folded literal in a project does not decide an outer and/or', async () => {
    const build = () => pipe(S)
      .select(c => ({ x: c.x, v: lit(1, t.int32).eq(lit(1, t.int32)) }))
      .select(c => ({ w: c.v.or(c.x.mod(lit(0, t.int32)).eq(lit(0, t.int32))) }));
    const input = table(S, rows);
    for (const plan of [build().compile(), build()._compile(false)]) {
      await expect(plan.execute(input)).rejects.toThrow();
    }
  });

  test('pushes a safe filter below a project', async () => {
    const build = () => pipe(S).select(c => ({ x: c.x, y: c.y, s: c.s.lower() })).filter(c => c.x.gt(1));
    const opt = build().compile();
    const raw = build()._compile(false);
    expect(raw.ir.nodes[1]?.op).toBe('project');
    expect(opt.ir.nodes[1]?.op).toBe('filter');
    expect(opt.ir.nodes[2]?.op).toBe('project');
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });
});

describe('projection pushdown', () => {
  test('inserts a narrow project before a filter', async () => {
    const build = () => pipe(S).filter(c => c.x.gt(1)).select(c => ({ s: c.s }));
    const opt = build().compile();
    const raw = build()._compile(false);
    expect(raw.ir.nodes[1]?.op).toBe('filter');
    expect(opt.ir.nodes[1]?.op).toBe('project');
    expect(opt.ir.nodes[1]?.op === 'project' ? opt.ir.nodes[1]!.exprs.length : 0).toBe(2);
    expect(opt.ir.nodes[2]?.op).toBe('filter');
    expect(opt.ir.nodes[3]?.op).toBe('project');
    expect(JSON.stringify(opt.ir.output)).toBe(JSON.stringify(raw.ir.output));
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });
});

describe('limit pushdown', () => {
  test('pushes a limit below a project that cannot fail', async () => {
    const build = () => pipe(S).select(c => ({ s: c.s.lower() })).limit(2);
    const opt = build().compile();
    const raw = build()._compile(false);
    expect(raw.ir.nodes[1]?.op).toBe('project');
    expect(opt.ir.nodes[1]?.op).toBe('limit');
    expect(opt.ir.nodes[2]?.op).toBe('project');
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });

  test('combines adjacent limits', async () => {
    const build = () => pipe(S).limit(5).limit(2);
    const opt = build().compile();
    const raw = build()._compile(false);
    expect(raw.ir.nodes.length).toBe(3);
    expect(opt.ir.nodes.length).toBe(2);
    expect(limitAt(opt.ir, 1)).toBe(2);
    const input = table(S, rows);
    expect((await opt.execute(input)).toArray()).toEqual((await raw.execute(input)).toArray());
  });
});
