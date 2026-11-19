// Plan execution (T-405, T-406): runs a chain of nodes over a snapshot, chunk by
// chunk. Streaming nodes (filter, project, limit) run inside a phase; a blocking
// node (aggregate, later sort) ends the phase, and what it produces is the source
// of the next. It mirrors the JS executor (src/backends/js/exec.ts): the same
// phases, chunks, order of evaluation and stop once a limit is satisfied, so the
// same rows and the same first error.
//
// Utf8 and dictionary columns hold per-segment codes. The host gives every such
// column a map from each segment's codes to canonical ids, one id per distinct
// string across the snapshot, numbered in code-point order of the strings (C-STR-ORDER).
// The scan applies the map, so from then on equal strings are equal ids and ids
// order like strings; results hold ids and the host turns them back into strings.

use std::borrow::Cow;
use std::rc::Rc;

use crate::agg::{Aggregator, Rows, Table};
use crate::sort::Sorter;
use crate::eval::{eval, supported, Batch, Params};
use crate::ir::{Expr, ExprKind, Op, Plan};
use crate::kernels::EvalError;
use crate::store::{Snapshot, View};
use crate::types::Type;
use crate::vector::{Data, Scalar, Values, Vector};

// Rows of the result in one column, owned.
pub struct OutColumn {
    pub ty: Type,
    pub values: Values<'static>,
    pub valid: Option<Vec<u8>>,
}

// Rows being read: a batch, and the rows of it still in play (None = all of them).
struct Stage<'a> {
    batch: Batch<'a>,
    sel: Option<Vec<u32>>,
    rows: usize,
}

struct Collector {
    types: Vec<Type>,
    // Which columns to keep; the others are skipped.
    keep: Vec<bool>,
    values: Vec<Option<Values<'static>>>,
    valid: Vec<Option<Vec<u8>>>,
    rows: usize,
}

// A phase: streaming nodes (positions in the chain) feeding one sink.
struct Phase {
    streaming: Vec<usize>,
    // The aggregate or sort node that ends the phase; None for the last phase, which collects rows.
    sink: Option<usize>,
}

enum Sink {
    Collect(Collector),
    Aggregate(Aggregator, usize),
    // The rows kept for later nodes, the sort keys, and the node.
    Sort(Collector, Sorter, usize),
}

enum Source {
    Table,
    // Rows held in memory, in the order of the selection if there is one (a sort's output).
    Owned(Rc<Table>, Option<Rc<Vec<u32>>>),
}

pub struct Run {
    plan: Rc<Plan>,
    params: Rc<Params>,
    snapshot: Snapshot,
    // Canonical-id maps for utf8 and dictionary columns, by scan column then segment.
    canon: Vec<Vec<Option<Vec<u32>>>>,
    // Nodes after the scan, in order.
    chain: Vec<usize>,
    // Per node index: which of its output columns anything later reads.
    needed: Vec<Vec<bool>>,
    chunk_rows: usize,
    phases: Vec<Phase>,
    phase: usize,
    source: Source,
    sink: Option<Sink>,
    // Position in the current source.
    segment: usize,
    pos: usize,
    // Rows a limit node still lets through, by position in `chain`.
    remaining: Vec<u64>,
    phase_done: bool,
    // Rows of the table's segments already passed, and rows read so far in all.
    passed: u64,
    scanned: u64,
    result: Option<Vec<OutColumn>>,
}

fn chain_of(plan: &Plan) -> Vec<usize> {
    // Purpose: the nodes from the one after the scan up to the root, in execution order
    let mut chain = Vec::new();
    let mut at = plan.root;
    loop {
        let input = match &plan.nodes[at].op {
            Op::Scan => break,
            Op::Filter { input, .. } | Op::Project { input, .. } | Op::Limit { input, .. } | Op::Aggregate { input, .. } | Op::Sort { input, .. } => *input,
        };
        chain.push(at);
        at = input;
    }
    chain.reverse();
    chain
}

pub fn reads(expr: &Expr, into: &mut [bool]) {
    // Purpose: mark the input columns an expression reads
    match &expr.kind {
        ExprKind::Field(i) => into[*i] = true,
        ExprKind::Literal(_) | ExprKind::Param(_) => {}
        ExprKind::Call { args, .. } => args.iter().for_each(|a| reads(a, into)),
        ExprKind::Cast(a) => reads(a, into),
        ExprKind::Lookup { arg, .. } => reads(arg, into),
        ExprKind::In { arg, list } => {
            reads(arg, into);
            // A list holds literals or a parameter, never columns.
            let _ = list;
        }
    }
}

fn needed_columns(plan: &Plan, chain: &[usize]) -> Vec<Vec<bool>> {
    // Purpose: for every node, which output columns later nodes (or the result) read
    let mut needed: Vec<Vec<bool>> = plan.nodes.iter().map(|n| vec![false; n.schema.len()]).collect();
    needed[plan.root] = vec![true; plan.nodes[plan.root].schema.len()];
    for &at in chain.iter().rev() {
        let out = needed[at].clone();
        match &plan.nodes[at].op {
            Op::Filter { input, predicate } => {
                let mut r = out;
                reads(predicate, &mut r);
                needed[*input] = r;
            }
            // Every expression is evaluated, whether or not its column is read later, so errors do not depend on pruning.
            Op::Project { input, exprs } => {
                let mut r = vec![false; plan.nodes[*input].schema.len()];
                exprs.iter().for_each(|e| reads(e, &mut r));
                needed[*input] = r;
            }
            Op::Limit { input, .. } => needed[*input] = out,
            // Keys and arguments are evaluated whether or not their results are read later.
            Op::Aggregate { input, keys, aggs } => {
                let mut r = vec![false; plan.nodes[*input].schema.len()];
                keys.iter().for_each(|e| reads(e, &mut r));
                aggs.iter().filter_map(|a| a.arg.as_ref()).for_each(|e| reads(e, &mut r));
                needed[*input] = r;
            }
            Op::Sort { input, keys } => {
                let mut r = out;
                keys.iter().for_each(|k| reads(&k.expr, &mut r));
                needed[*input] = r;
            }
            Op::Scan => {}
        }
    }
    needed
}

pub fn check_supported(plan: &Plan) -> Result<(), EvalError> {
    // Purpose: whether the engine can run this whole plan; the host runs it on the JS backend if not
    for node in &plan.nodes {
        match &node.op {
            Op::Scan | Op::Limit { .. } => {}
            Op::Filter { predicate, .. } => supported(predicate).map_err(EvalError::Unsupported)?,
            Op::Project { exprs, .. } => {
                for e in exprs {
                    supported(e).map_err(EvalError::Unsupported)?;
                }
            }
            Op::Aggregate { keys, aggs, .. } => {
                for e in keys.iter().chain(aggs.iter().filter_map(|a| a.arg.as_ref())) {
                    supported(e).map_err(EvalError::Unsupported)?;
                }
            }
            Op::Sort { keys, .. } => {
                for k in keys {
                    supported(&k.expr).map_err(EvalError::Unsupported)?;
                }
            }
        }
    }
    Ok(())
}

impl Collector {
    fn new(types: Vec<Type>, keep: Vec<bool>) -> Collector {
        // Purpose: an empty collector for columns of these types, keeping the ones marked
        let n = types.len();
        Collector { types, keep, values: (0..n).map(|_| None).collect(), valid: (0..n).map(|_| None).collect(), rows: 0 }
    }

    fn add(&mut self, batch: Batch<'_>, rows: usize) {
        // Purpose: append a dense batch's rows to the result
        for (c, column) in batch.columns.into_iter().enumerate() {
            let Some(vector) = column else { continue };
            if !self.keep[c] {
                continue;
            }
            let (values, valid) = vector.into_columns(rows);
            match &mut self.values[c] {
                Some(acc) => acc.append(&values),
                slot => *slot = Some(values.into_owned()),
            }
            match (&mut self.valid[c], valid) {
                (Some(acc), Some(v)) => acc.extend_from_slice(&v),
                (Some(acc), None) => acc.resize(acc.len() + rows, 1),
                (slot @ None, Some(v)) => {
                    let mut acc = vec![1u8; self.rows];
                    acc.extend_from_slice(&v);
                    *slot = Some(acc);
                }
                (None, None) => {}
            }
        }
        self.rows += rows;
    }

    fn finish(self) -> Vec<OutColumn> {
        // Purpose: the collected columns
        let rows = self.rows;
        self.types
            .into_iter()
            .zip(self.values)
            .zip(self.valid)
            .map(|((ty, values), valid)| OutColumn { ty, values: values.unwrap_or_else(|| Values::empty(ty)), valid: valid.filter(|v| v.len() == rows) })
            .collect()
    }
}

fn dense<'a>(stage: Stage<'a>) -> (Batch<'a>, usize) {
    // Purpose: the stage's rows as a batch holding only them (copying through the selection if there is one)
    let Stage { batch, sel, rows } = stage;
    match sel {
        None => (batch, rows),
        Some(sel) => {
            let columns = batch.columns.iter().map(|c| c.as_ref().map(|v| v.gather(&sel))).collect();
            (Batch { rows, columns }, rows)
        }
    }
}

fn prune(batch: &mut Batch<'_>, needed: &[bool]) {
    // Purpose: drop the columns nothing later reads
    for (c, slot) in batch.columns.iter_mut().enumerate() {
        if !needed[c] {
            *slot = None;
        }
    }
}

fn keep_rows(predicate: &Vector<'_>, rows: usize) -> Option<Vec<u32>> {
    // Purpose: the rows where a predicate is true (null and false are dropped); None when all of them stay
    match &predicate.data {
        Data::Const(Scalar::U8(v)) => {
            if *v == 1 || rows == 0 {
                None
            } else {
                Some(Vec::new())
            }
        }
        Data::Const(_) => None,
        Data::Col { values: Values::U8(keep), valid } => {
            let mut out: Vec<u32> = Vec::with_capacity(rows);
            match valid {
                None => {
                    for (i, &k) in keep.iter().enumerate() {
                        if k != 0 {
                            out.push(i as u32);
                        }
                    }
                }
                Some(v) => {
                    for i in 0..keep.len() {
                        if keep[i] != 0 && v[i] != 0 {
                            out.push(i as u32);
                        }
                    }
                }
            }
            if out.len() == rows {
                None
            } else {
                Some(out)
            }
        }
        Data::Col { .. } => None,
    }
}


fn scan_column<'a>(view: &'a View, col: usize, ty: Type, start: usize, rows: usize, map: Option<&[u32]>, code: bool) -> Result<Vector<'a>, EvalError> {
    // Purpose: one column of a chunk of a segment; a utf8 or dictionary column is mapped to canonical ids
    if !code {
        return Ok(crate::eval::column_vector(view, col, ty, start, rows));
    }
    let map = map.ok_or(EvalError::NeedsMap("a utf8 or dictionary column came without its map"))?;
    let codes = &view.values::<i32>(col)[start..start + rows];
    let valid = view.valid(col).map(|v| &v[start..start + rows]);
    let mut out = Vec::with_capacity(rows);
    for i in 0..rows {
        if valid.is_some_and(|v| v[i] == 0) {
            // A null row's code means nothing.
            out.push(0);
            continue;
        }
        match map.get(codes[i] as u32 as usize) {
            Some(&id) => out.push(id as i32),
            None => return Err(EvalError::NeedsMap("a dictionary map is shorter than its dictionary")),
        }
    }
    Ok(Vector::column(ty, Values::I32(Cow::Owned(out)), valid.map(Cow::Borrowed)))
}

fn is_code(ty: Type) -> bool {
    // Purpose: whether a column holds per-segment string codes
    matches!(ty, Type::Utf8 | Type::Dictionary)
}

fn out_columns(table: Table, types: &[Type]) -> Vec<OutColumn> {
    // Purpose: a table held in memory as result columns
    let rows = table.rows;
    table
        .columns
        .into_iter()
        .zip(types)
        .map(|(v, &ty)| {
            let (values, valid) = v.into_columns(rows);
            OutColumn { ty, values: values.into_owned(), valid: valid.map(|c| c.into_owned()) }
        })
        .collect()
}

impl Run {
    pub fn new(plan: Rc<Plan>, params: Rc<Params>, snapshot: Snapshot, chunk_rows: usize) -> Result<Run, EvalError> {
        // Purpose: prepare a run; refuses a plan the engine cannot execute
        check_supported(&plan)?;
        let chain = chain_of(&plan);
        let needed = needed_columns(&plan, &chain);
        let remaining = chain
            .iter()
            .map(|&i| match &plan.nodes[i].op {
                Op::Limit { count, .. } => *count,
                _ => 0,
            })
            .collect();
        let mut phases = Vec::new();
        let mut streaming = Vec::new();
        for (k, &at) in chain.iter().enumerate() {
            if matches!(plan.nodes[at].op, Op::Aggregate { .. } | Op::Sort { .. }) {
                phases.push(Phase { streaming: std::mem::take(&mut streaming), sink: Some(at) });
            } else {
                streaming.push(k);
            }
        }
        phases.push(Phase { streaming, sink: None });
        let canon = (0..plan.input.len()).map(|_| vec![None; snapshot.segments.len()]).collect();
        let mut run = Run {
            plan,
            params,
            snapshot,
            canon,
            chain,
            needed,
            chunk_rows: chunk_rows.max(1),
            phases,
            phase: 0,
            source: Source::Table,
            sink: None,
            segment: 0,
            pos: 0,
            remaining,
            phase_done: false,
            passed: 0,
            scanned: 0,
            result: None,
        };
        run.sink = Some(run.new_sink()?);
        Ok(run)
    }

    pub fn set_canon(&mut self, column: usize, segment: usize, map: Vec<u32>) -> bool {
        // Purpose: give a utf8 or dictionary column's segment its map to canonical ids; false if there is no such column or segment
        match self.canon.get_mut(column).and_then(|c| c.get_mut(segment)) {
            Some(slot) => {
                *slot = Some(map);
                true
            }
            None => false,
        }
    }

    fn new_sink(&self) -> Result<Sink, EvalError> {
        // Purpose: the sink that ends the current phase
        match self.phases[self.phase].sink {
            Some(at) => match &self.plan.nodes[at].op {
                Op::Aggregate { keys, aggs, .. } => {
                    let key_types: Vec<Type> = keys.iter().map(|k| k.ty).collect();
                    Ok(Sink::Aggregate(Aggregator::new(&key_types, aggs)?, at))
                }
                Op::Sort { keys, .. } => {
                    // A limit right after the sort only ever reads the first rows of the order.
                    let position = self.chain.iter().position(|&i| i == at).expect("the sort is in the chain");
                    let limit = match self.chain.get(position + 1).map(|&i| &self.plan.nodes[i].op) {
                        Some(Op::Limit { count, .. }) => Some((*count).min(usize::MAX as u64) as usize),
                        _ => None,
                    };
                    let types = self.plan.nodes[at].schema.iter().map(|f| f.ty).collect();
                    Ok(Sink::Sort(Collector::new(types, self.needed[at].clone()), Sorter::new(keys, limit), at))
                }
                _ => unreachable!("phases end at aggregates and sorts"),
            },
            None => {
                let types: Vec<Type> = self.plan.output.iter().map(|f| f.ty).collect();
                let keep = vec![true; types.len()];
                Ok(Sink::Collect(Collector::new(types, keep)))
            }
        }
    }

    pub fn rows_scanned(&self) -> u64 {
        // Purpose: table rows read so far
        self.scanned
    }

    pub fn is_finished(&self) -> bool {
        // Purpose: whether the result is ready
        self.result.is_some()
    }

    fn exhausted(&mut self) -> bool {
        // Purpose: whether the current source has no rows left (skipping empty and finished segments)
        match &self.source {
            Source::Table => {
                while self.segment < self.snapshot.segments.len() && self.pos >= self.snapshot.segments[self.segment].rows as usize {
                    self.passed += self.snapshot.segments[self.segment].rows as u64;
                    self.segment += 1;
                    self.pos = 0;
                }
                self.segment >= self.snapshot.segments.len()
            }
            Source::Owned(t, order) => self.pos >= order.as_ref().map_or(t.rows, |o| o.len()),
        }
    }

    fn end_phase(&mut self) -> Result<(), EvalError> {
        // Purpose: the current source is used up: finish the sink and either start the next phase or set the result
        match self.sink.take().expect("a phase has a sink") {
            Sink::Collect(c) => self.result = Some(c.finish()),
            Sink::Aggregate(a, _) => {
                let table = a.finish()?;
                self.phase += 1;
                self.source = Source::Owned(Rc::new(table), None);
                self.segment = 0;
                self.pos = 0;
                self.phase_done = false;
                self.sink = Some(self.new_sink()?);
            }
            Sink::Sort(collector, sorter, _) => {
                let rows = collector.rows;
                let order = sorter.finish();
                let columns = collector
                    .finish()
                    .into_iter()
                    .map(|c| Vector::column(c.ty, c.values, c.valid.map(Cow::Owned)))
                    .collect();
                self.phase += 1;
                self.source = Source::Owned(Rc::new(Table { rows, columns }), Some(Rc::new(order)));
                self.segment = 0;
                self.pos = 0;
                self.phase_done = false;
                self.sink = Some(self.new_sink()?);
            }
        }
        Ok(())
    }

    pub fn step(&mut self) -> Result<bool, EvalError> {
        // Purpose: process one chunk (or end a phase); true once the result is ready
        if self.result.is_some() {
            return Ok(true);
        }
        // A last phase with nothing to stream: the table the previous phase made is the result.
        if self.phase + 1 == self.phases.len() && self.phases[self.phase].streaming.is_empty() {
            if let Source::Owned(t, order) = &self.source {
                let table = match order {
                    // A sort's rows are gathered once, in order; every column is read here.
                    Some(order) => Table { rows: order.len(), columns: t.columns.iter().map(|c| c.gather(order)).collect() },
                    None => Table { rows: t.rows, columns: t.columns.iter().map(|c| c.reborrow().into_static()).collect() },
                };
                let types: Vec<Type> = self.plan.output.iter().map(|f| f.ty).collect();
                self.result = Some(out_columns(table, &types));
                self.sink = None;
                return Ok(true);
            }
        }
        if self.phase_done || self.exhausted() {
            self.end_phase()?;
            return Ok(self.result.is_some());
        }
        let plan = Rc::clone(&self.plan);
        let params = Rc::clone(&self.params);
        let owned = match &self.source {
            Source::Owned(t, order) => Some((Rc::clone(t), order.clone())),
            Source::Table => None,
        };
        let view = if owned.is_none() { Some(self.snapshot.segments[self.segment].clone()) } else { None };
        let start = self.pos;
        let total = match (&owned, &view) {
            (Some((t, order)), _) => order.as_ref().map_or(t.rows, |o| o.len()),
            (None, Some(v)) => v.rows as usize,
            _ => unreachable!(),
        };
        let rows = (total - start).min(self.chunk_rows);
        // The node whose output the chunk's columns are, for pruning.
        let source_node = if self.phase == 0 { 0 } else { self.phases[self.phase - 1].sink.expect("later phases follow an aggregate or a sort") };
        let mut stage = match (&owned, &view) {
            (Some((t, None)), _) => {
                let columns = t.columns.iter().enumerate().map(|(c, v)| if self.needed[source_node][c] { Some(v.slice(start, rows)) } else { None }).collect();
                Stage { batch: Batch { rows, columns }, sel: None, rows }
            }
            // A sort's output: the rows as gathered, read through the next stretch of the order.
            (Some((t, Some(order))), _) => {
                let columns = t.columns.iter().enumerate().map(|(c, v)| if self.needed[source_node][c] { Some(v.reborrow()) } else { None }).collect();
                Stage { batch: Batch { rows: t.rows, columns }, sel: Some(order[start..start + rows].to_vec()), rows }
            }
            (None, Some(view)) => {
                let mut columns: Vec<Option<Vector>> = Vec::with_capacity(plan.input.len());
                for (c, field) in plan.input.iter().enumerate() {
                    if !self.needed[0][c] {
                        columns.push(None);
                        continue;
                    }
                    let map = self.canon[c][self.segment].as_deref();
                    columns.push(Some(scan_column(view, c, field.ty, start, rows, map, is_code(field.ty))?));
                }
                Stage { batch: Batch { rows, columns }, sel: None, rows }
            }
            _ => unreachable!(),
        };
        for &k in &self.phases[self.phase].streaming {
            let at = self.chain[k];
            match &plan.nodes[at].op {
                Op::Filter { predicate, .. } => {
                    let (input, n) = dense(stage);
                    let predicate = eval(predicate, &input, &params)?;
                    let sel = keep_rows(&predicate, n);
                    let count = sel.as_ref().map_or(n, |s| s.len());
                    let mut batch = input;
                    prune(&mut batch, &self.needed[at]);
                    stage = Stage { batch, sel, rows: count };
                }
                Op::Project { exprs, .. } => {
                    let (input, n) = dense(stage);
                    let mut columns = Vec::with_capacity(exprs.len());
                    for e in exprs {
                        columns.push(Some(eval(e, &input, &params)?));
                    }
                    let mut batch = Batch { rows: n, columns };
                    prune(&mut batch, &self.needed[at]);
                    stage = Stage { batch, sel: None, rows: n };
                }
                Op::Limit { .. } => {
                    let left = self.remaining[k];
                    let count = left.min(stage.rows as u64) as usize;
                    self.remaining[k] = left - count as u64;
                    if count < stage.rows {
                        match &mut stage.sel {
                            Some(sel) => sel.truncate(count),
                            None => {
                                stage.batch.columns.iter_mut().flatten().for_each(|v| v.truncate(count));
                                stage.batch.rows = count;
                            }
                        }
                        stage.rows = count;
                    }
                    prune(&mut stage.batch, &self.needed[at]);
                    // Once a limit is satisfied, nothing later in the source can matter.
                    if left - count as u64 == 0 {
                        self.phase_done = true;
                    }
                }
                _ => return Err(EvalError::Internal("operator is not streaming")),
            }
            if stage.rows == 0 {
                break;
            }
        }
        if stage.rows > 0 {
            let mut sink = self.sink.take().expect("a phase has a sink");
            let outcome = consume(&mut sink, stage, &plan, &params);
            self.sink = Some(sink);
            outcome?;
        }
        self.pos += rows;
        if self.phase == 0 {
            self.scanned = self.passed + self.pos as u64;
        }
        Ok(false)
    }

    pub fn finish(self) -> Vec<OutColumn> {
        // Purpose: the result columns of a finished run
        self.result.unwrap_or_default()
    }
}

fn consume(sink: &mut Sink, stage: Stage<'_>, plan: &Plan, params: &Params) -> Result<(), EvalError> {
    // Purpose: hand one chunk's rows to the sink that ends the phase
    match sink {
        Sink::Collect(c) => {
            let (batch, n) = dense(stage);
            c.add(batch, n);
        }
        Sink::Sort(collector, sorter, at) => {
            let Op::Sort { keys, .. } = &plan.nodes[*at].op else { unreachable!("a sort sink holds a sort node") };
            let (batch, n) = dense(stage);
            let key_vectors = keys.iter().map(|k| eval(&k.expr, &batch, params)).collect::<Result<Vec<_>, _>>()?;
            sorter.consume(&key_vectors, n);
            collector.add(batch, n);
        }
        Sink::Aggregate(agg, at) => {
            let Op::Aggregate { keys, aggs, .. } = &plan.nodes[*at].op else { unreachable!("an aggregate sink holds an aggregate node") };
            // Plain column references can be read through the selection without copying.
            let direct = keys.iter().chain(aggs.iter().filter_map(|a| a.arg.as_ref())).all(|e| matches!(e.kind, ExprKind::Field(_)));
            let Stage { batch, sel, rows } = stage;
            let (batch, sel) = if sel.is_some() && direct { (batch, sel) } else { (dense(Stage { batch, sel, rows }).0, None) };
            let key_vectors = keys.iter().map(|e| eval(e, &batch, params)).collect::<Result<Vec<_>, _>>()?;
            let args = aggs.iter().map(|a| a.arg.as_ref().map(|e| eval(e, &batch, params)).transpose()).collect::<Result<Vec<_>, _>>()?;
            agg.consume(&key_vectors, &args, &Rows { count: rows, sel: sel.as_deref() })?;
        }
    }
    Ok(())
}
