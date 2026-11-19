// T-501: Substrait export and import round-trips exactly, names are pinned, and
// malformed JSON is refused with a structured error.

import { describe, expect, test } from 'bun:test';
import { compilePlans } from '../demo/dashboard';
import { count, ifElse, list, pipe, schema, t } from '../src';
import { PlanError } from '../src/errors';
import type { IrExpr, IrPlan, LiteralValue } from '../src/ir';
import { IR_VERSION } from '../src/ir';
import { REGISTRY } from '../src/registry';
import { SUBSTRAIT_VERSION, exportPlan, importPlan } from '../src/substrait';
import type { SubstraitPlanJson } from '../src/substrait';
import type { DataType } from '../src/types';
import { validate } from '../src/validate';

const People = schema({
  name: t.utf8,
  age: t.int32,
  big: t.int64,
  score: t.float64,
  city: t.dictionary,
  born: t.date32,
  seen: t.timestamp,
  ok: t.bool,
});

// Every Substrait name used by src/registry.ts at the pinned release. v0.108.0
// defines these names in extensions/*.yaml and the IfThen expression in
// proto/substrait/algebra.proto.
const ALLOWLIST: ReadonlySet<string> = new Set([
  'functions_comparison:equal',
  'functions_comparison:not_equal',
  'functions_comparison:lt',
  'functions_comparison:lte',
  'functions_comparison:gt',
  'functions_comparison:gte',
  'functions_comparison:is_null',
  'functions_comparison:is_nan',
  'functions_comparison:coalesce',
  'expression:if_then',
  'functions_boolean:and',
  'functions_boolean:or',
  'functions_boolean:not',
  'functions_arithmetic:add',
  'functions_arithmetic:subtract',
  'functions_arithmetic:multiply',
  'functions_arithmetic:divide',
  'functions_arithmetic:modulus',
  'functions_arithmetic:negate',
  'functions_arithmetic:abs',
  'functions_rounding:floor',
  'functions_rounding:ceil',
  'functions_rounding:round',
  'functions_string:lower',
  'functions_string:upper',
  'functions_string:char_length',
  'functions_string:starts_with',
  'functions_string:ends_with',
  'functions_string:contains',
  'functions_datetime:round_temporal',
  'functions_datetime:extract',
  'functions_aggregate_generic:count',
  'functions_arithmetic:sum',
  'functions_arithmetic:avg',
  'functions_arithmetic:min',
  'functions_arithmetic:max',
]);

function roundTrip(plan: IrPlan): IrPlan {
  // Purpose: export, pass through real JSON text, import, and require the original plan
  const json = exportPlan(plan);
  const parsed: unknown = JSON.parse(JSON.stringify(json));
  const back = importPlan(parsed);
  expect(back).toEqual(plan);
  return back;
}

function literalPlan(values: readonly LiteralValue[], type: DataType): IrPlan {
  // Purpose: a scan and a project of one literal per value, for literal edge cases
  const field = { name: 'v', type };
  const exprs: IrExpr[] = values.map(function (value) {
    // Purpose: one typed literal
    return { kind: 'literal', value, type };
  });
  const out = values.map(function (_, i) {
    // Purpose: one output field
    return { name: `c${i}`, type };
  });
  return {
    version: IR_VERSION,
    input: [field],
    nodes: [{ op: 'scan', schema: [field] }, { op: 'project', input: 0, exprs, schema: out }],
    root: 1,
    output: out,
    params: [],
  };
}

function find(root: unknown, predicate: (o: Record<string, unknown>) => boolean): Record<string, unknown> {
  // Purpose: find the first object in a JSON tree satisfying a predicate
  if (Array.isArray(root)) {
    for (const item of root) {
      try {
        return find(item, predicate);
      } catch {
        // keep looking
      }
    }
  } else if (typeof root === 'object' && root !== null) {
    const o = root as Record<string, unknown>;
    if (predicate(o)) return o;
    for (const value of Object.values(o)) {
      try {
        return find(value, predicate);
      } catch {
        // keep looking
      }
    }
  }
  throw new Error('no matching object');
}

function clone(json: SubstraitPlanJson): unknown {
  // Purpose: a detached copy of exported JSON, as if received from another tool
  return JSON.parse(JSON.stringify(json)) as unknown;
}

const allKinds = pipe(People, { lim: t.int32, names: list(t.dictionary), factor: t.float64 })
  .filter((c, p) =>
    c.age.gt(p.lim)
      .and(c.city.isIn(p.names))
      .and(c.name.isIn(['Ada', 'Grace']))
      .or(ifElse(c.ok, c.score.gt(p.factor), false)),
  )
  .select(function (c) {
    // Purpose: project every expression shape the IR has
    return {
      name: c.name,
      age: c.age,
      big: c.big.add(1n),
      scaled: c.age.cast(t.float64).mul(2),
      upper: c.name.upper(),
      ok: c.ok.not(),
    };
  })
  .groupBy(function (c) {
    // Purpose: group by a projected column
    return { upper: c.upper };
  })
  .agg(function (c) {
    // Purpose: use row-count and column aggregates
    return { n: count(), total: c.scaled.sum(), uniq: c.age.countDistinct(), low: c.scaled.min() };
  })
  .sort(function (c) {
    // Purpose: sort descending and with nulls first
    return [c.n.desc(), c.low.asc().nullsFirst()];
  })
  .limit(7)
  .compile().ir;

describe('pinned names', () => {
  test('the version is pinned and every registry name is in the allowlist', () => {
    expect(SUBSTRAIT_VERSION).toBe('0.108.0');
    const found = [...REGISTRY.values()].map(function (def) {
      // Purpose: collect the Substrait names the registry actually uses
      return def.substrait;
    });
    expect([...new Set(found)].sort()).toEqual([...ALLOWLIST].sort());
    expect(ALLOWLIST.size).toBe(new Set(found).size);
    for (const def of REGISTRY.values()) {
      expect(ALLOWLIST.has(def.substrait)).toBe(true);
      expect(def.kind === 'scalar' || def.kind === 'aggregate').toBe(true);
    }
  });

  test('the exported version object matches the pinned constant', () => {
    expect(exportPlan(allKinds).version).toEqual({
      major_number: 0,
      minor_number: 108,
      patch_number: 0,
      producer: 'zamda',
    });
  });

  test('export writes the registry Substrait names, not the zamda names', () => {
    const calls: IrExpr[] = [...REGISTRY.values()]
      .filter(function (def) {
        // Purpose: if_else is an IfThen expression, not a scalar function call
        return def.kind === 'scalar';
      })
      .map(function (def): IrExpr {
        // Purpose: a call with the right name; argument types are not checked on export
        if (def.name === 'if_else') {
          const arg: IrExpr = { kind: 'literal', value: true, type: t.bool };
          return { kind: 'call', fn: def.name, args: [arg, arg, arg], type: t.bool };
        }
        return { kind: 'call', fn: def.name, args: [], type: t.bool };
      });
    const aggs = [...REGISTRY.values()]
      .filter(function (def) {
        // Purpose: only aggregate definitions belong in a measure
        return def.kind === 'aggregate';
      })
      .map(function (def) {
        // Purpose: an aggregate with the right name
        return { fn: def.name, arg: null, type: t.bool };
      });
    const field = { name: 'v', type: t.bool };
    const plan: IrPlan = {
      version: IR_VERSION,
      input: [field],
      nodes: [
        { op: 'scan', schema: [field] },
        { op: 'project', input: 0, exprs: calls, schema: calls.map(function () {
          // Purpose: one bool output per call
          return field;
        }) },
        { op: 'aggregate', input: 1, keys: [], aggs, schema: [] },
      ],
      root: 2,
      output: [],
      params: [],
    };
    const text = JSON.stringify(exportPlan(plan));
    for (const def of REGISTRY.values()) {
      if (def.name === 'if_else') expect(text).toContain('"expr":"ifThen"');
      else expect(text).toContain(JSON.stringify(def.substrait));
    }
  });
});

describe('round trip', () => {
  test('the dashboard plans, with scalar and list parameters, round trip', () => {
    for (const plan of Object.values(compilePlans())) roundTrip(plan.ir);
  });

  test('every node and expression kind round trips', () => {
    const ops = allKinds.nodes.map(function (node) {
      // Purpose: collect the exported node kinds
      return node.op;
    });
    expect(new Set(ops)).toEqual(new Set(['scan', 'filter', 'project', 'aggregate', 'sort', 'limit']));
    const json = exportPlan(allKinds);
    const tags = new Set<string>();
    for (const expr of findExpressions(json)) tags.add(String(expr.expr));
    expect([...tags].sort()).toEqual(['call', 'cast', 'field', 'ifThen', 'in', 'literal', 'param'].sort());
    roundTrip(allKinds);
  });

  test('a round-tripped plan still validates', () => {
    expect(validate(roundTrip(allKinds))).toEqual(allKinds);
  });

  test('literal kinds and edge values, including bigint, come back exactly', () => {
    const numbers: LiteralValue[] = [
      0, -0, 1, -1, 0.1, -1.5, Number.MAX_VALUE, Number.MIN_VALUE,
      NaN, Infinity, -Infinity, 2 ** 53, 2 ** 53 + 1,
    ];
    const bigints: LiteralValue[] = [
      0n, 1n, -1n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 64n - 1n, -(2n ** 64n) + 1n,
    ];
    const strings: LiteralValue[] = ['', 'x', 'naïve ☃ 😀', 'line\nbreak', 'a'.repeat(300)];
    const bools: LiteralValue[] = [true, false];
    const back = [
      roundTrip(literalPlan(numbers, t.float64)),
      roundTrip(literalPlan(bigints, t.int64)),
      roundTrip(literalPlan(strings, t.utf8)),
      roundTrip(literalPlan(bools, t.bool)),
    ];
    const got = back.map(function (plan) {
      // Purpose: read the literal values back out of each project node
      return (plan.nodes[1] as unknown as { exprs: { value: LiteralValue }[] }).exprs.map(function (e) {
        // Purpose: one literal value
        return e.value;
      });
    });
    for (let i = 0; i < numbers.length; i++) expect(Object.is(got[0]![i], numbers[i])).toBe(true);
    expect(got[1]).toEqual(bigints);
    expect(got[2]).toEqual(strings);
    expect(got[3]).toEqual(bools);

    const json = exportPlan(literalPlan([-0, NaN, Infinity, 2n ** 63n - 1n], t.float64));
    const text = JSON.stringify(json);
    expect(text).toContain('"value":"-0"');
    expect(text).toContain('"value":"NaN"');
    expect(text).toContain('"value":"Infinity"');
    expect(text).toContain('"value":"9223372036854775807"');
  });

  test('nulls in the IR round trip: row counts, list values and list params', () => {
    const rowCount = pipe(People).agg(function () {
      // Purpose: count() has no argument column
      return { n: count() };
    }).compile().ir;
    const json = exportPlan(rowCount);
    expect(find(json, function (o) {
      // Purpose: find the row-count measure
      return o.fn === 'count';
    }).arg).toBe(null);
    roundTrip(rowCount);

    const doc = exportPlan(allKinds) as unknown;
    const ins = [find(doc, function (o) {
      // Purpose: find the in-list on the list parameter
      return o.expr === 'in' && o.param === 'names';
    }), find(doc, function (o) {
      // Purpose: find the in-list with literal values
      return o.expr === 'in' && o.values !== null;
    })];
    expect(ins[0]!.values).toBe(null);
    expect(ins[1]!.param).toBe(null);
    expect((ins[1]!.values as unknown[]).length).toBe(2);
    roundTrip(allKinds);
  });

  test('export is JSON-safe and stable across a second export', () => {
    const first = exportPlan(allKinds);
    expect(exportPlan(importPlan(JSON.parse(JSON.stringify(first)) as unknown))).toEqual(first);
  });
});

function findExpressions(root: unknown): Record<string, unknown>[] {
  // Purpose: collect every expression object from a JSON plan
  const out: Record<string, unknown>[] = [];
  const visit = function (value: unknown): void {
    // Purpose: walk a JSON tree
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (typeof value === 'object' && value !== null) {
      const o = value as Record<string, unknown>;
      if (typeof o.expr === 'string') out.push(o);
      for (const child of Object.values(o)) visit(child);
    }
  };
  visit(root);
  return out;
}

const good = exportPlan(allKinds);

function mutated(change: (o: Record<string, unknown>) => void): unknown {
  // Purpose: change one field of a detached copy of a valid plan
  const doc = clone(good);
  change(doc as Record<string, unknown>);
  return doc;
}

function top(change: (o: Record<string, unknown>) => void): Record<string, unknown> {
  // Purpose: mutate a top-level field of a valid JSON plan
  const doc = clone(good) as Record<string, unknown>;
  change(doc);
  return doc;
}

describe('malformed input', () => {
  test('non-objects, wrong versions and wrong top-level fields are PlanErrors', () => {
    for (const value of [null, undefined, 42, 'plan', [], true]) {
      expect(() => importPlan(value)).toThrow(PlanError);
    }
    expect(() => importPlan(function () {
      // Purpose: a function is not JSON
      return 1;
    })).toThrow(PlanError);
    expect(function () {
      // Purpose: reject a wrong Substrait release
      importPlan(mutated(function (o) {
        (o.version as Record<string, unknown>).minor_number = 999;
      }));
    }).toThrow(/plan\.version\.minor_number: expected .*found/);
    expect(() => importPlan(top(function (o) {
      // Purpose: reject a wrong IR version
      o.ir_version = IR_VERSION + 1;
    }))).toThrow(/plan\.ir_version: expected .*found/);
    expect(() => importPlan(top(function (o) {
      // Purpose: reject an unknown field
      o.surprise = 1;
    }))).toThrow(/plan: expected exactly the fields/);
    const missing = clone(good) as Record<string, unknown>;
    delete missing.output;
    expect(() => importPlan(missing)).toThrow(PlanError);
    expect(() => importPlan(top(function (o) {
      // Purpose: reject an out-of-range root
      o.root = 999;
    }))).toThrow(/plan\.root: expected .*found/);
  });

  test('unknown relations, bad inputs and scan placement are refused', () => {
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject an unsupported relation
      (o.relations as Record<string, unknown>[])[1]!.rel = 'join';
    }))).toThrow(/plan\.relations\[1\]\.rel: expected a supported relation, found string "join"/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a second scan
      const rel = (o.relations as Record<string, unknown>[])[1]!;
      rel.rel = 'read';
      delete rel.input;
      delete rel.expressions;
    }))).toThrow(/a read relation only at node 0/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a forward reference
      (o.relations as Record<string, unknown>[])[2]!.input = 99;
    }))).toThrow(/plan\.relations\[2\]\.input: expected/);
  });

  test('unknown or mismatched functions and types are refused', () => {
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a function outside the registry
      find(o, function (e) {
        return e.expr === 'call';
      }).fn = 'nope';
    }))).toThrow(/fn: expected a registered scalar function name, found string "nope"/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a function whose Substrait name differs from the registry
      find(o, function (e) {
        return e.expr === 'call';
      }).substrait = 'functions_arithmetic:nope';
    }))).toThrow(/expected functions_/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a non-canonical scalar call for if_else
      find(o, function (e) {
        return e.expr === 'call';
      }).fn = 'if_else';
    }))).toThrow(/expected an ifThen expression for if_else/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject an aggregate that claims to be distinct
      find(o, function (e) {
        return e.distinct === false;
      }).distinct = true;
    }))).toThrow(/expected false for this aggregate/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject an unknown type
      find(o, function (e) {
        return e.zamda === 'int32';
      }).zamda = 'decimal';
    }))).toThrow(/expected a supported zamda type/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a type whose Substrait name disagrees with its zamda name
      find(o, function (e) {
        return e.zamda === 'int32';
      }).substrait = 'fp64';
    }))).toThrow(/expected i32/);
  });

  test('bad literals, null forms and sort flags are refused', () => {
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a non-canonical number spelling
      find(o, function (e) {
        return e.kind === 'number';
      }).value = '1e2';
    }))).toThrow(/expected the canonical number/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a bigint with a leading zero
      find(o, function (e) {
        return e.kind === 'bigint';
      }).value = '01';
    }))).toThrow(/expected a canonical decimal integer string/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject a null literal, which the IR does not have
      find(o, function (e) {
        return e.kind === 'bigint';
      }).kind = 'null';
    }))).toThrow(/expected boolean, number, bigint or string/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject an in-list that sets both forms
      const e = find(o, function (v) {
        return v.expr === 'in' && v.param === 'names';
      });
      e.values = [];
    }))).toThrow(/expected exactly one of values and param/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject an in-list that sets neither form
      const e = find(o, function (v) {
        return v.expr === 'in' && v.param === 'names';
      });
      e.values = null;
      e.param = null;
    }))).toThrow(/expected exactly one of values and param/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject an unknown sort direction
      find(o, function (e) {
        return e.direction !== undefined;
      }).direction = 'sideways';
    }))).toThrow(/expected asc or desc/);
    expect(() => importPlan(mutated(function (o) {
      // Purpose: reject an unknown null ordering
      find(o, function (e) {
        return e.nulls !== undefined;
      }).nulls = 'middle';
    }))).toThrow(/expected first or last/);
  });
});

describe('unsupported export input', () => {
  test('export refuses unknown versions, kinds, functions and types', () => {
    expect(() => exportPlan({ ...allKinds, version: IR_VERSION + 1 })).toThrow(PlanError);
    const badExpr = { kind: 'lookup', arg: { kind: 'field', index: 0, type: t.bool }, type: t.bool } as unknown as IrExpr;
    expect(() => exportPlan(literalPlan([1], t.int32))).not.toThrow();
    expect(() => exportPlan({
      ...literalPlan([1], t.int32),
      nodes: [
        { op: 'scan', schema: [{ name: 'v', type: t.int32 }] },
        { op: 'project', input: 0, exprs: [badExpr], schema: [] },
      ],
    })).toThrow(/expected a supported expression kind/);
    expect(() => exportPlan({
      ...literalPlan([1], t.int32),
      nodes: [
        { op: 'scan', schema: [{ name: 'v', type: t.int32 }] },
        { op: 'project', input: 0, exprs: [{ kind: 'call', fn: 'nope', args: [], type: t.bool }], schema: [] },
      ],
    })).toThrow(/expected a registered scalar function name/);
    expect(() => exportPlan(literalPlan([1], { name: 'decimal' } as unknown as DataType)))
      .toThrow(/expected a supported zamda type/);
    expect(() => exportPlan({ ...allKinds, root: 1, nodes: [
      { op: 'scan', schema: [] },
      { op: 'filter', input: 7, predicate: { kind: 'literal', value: true, type: t.bool }, schema: [] },
    ] })).toThrow(/expected an earlier node index/);
  });
});
