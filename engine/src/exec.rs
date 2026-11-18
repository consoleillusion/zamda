// Plan execution (T-405): runs a chain scan -> (filter | project | limit)* over a
// snapshot, chunk by chunk, and collects the rows. It mirrors the JS executor
// (src/backends/js/exec.ts): the same chunks, the same order of evaluation, the
// same stop once a limit is satisfied, so the same rows and the same first error.
// Aggregate and sort (T-406, T-407) will plug in as sinks of the same driver.

use std::rc::Rc;

use crate::eval::{eval, supported, Batch, Params};
use crate::ir::{Expr, ExprKind, Op, Plan};
use crate::kernels::EvalError;
use crate::store::Snapshot;
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
    values: Vec<Option<Values<'static>>>,
    valid: Vec<Option<Vec<u8>>>,
    rows: usize,
}

pub struct Run {
    plan: Rc<Plan>,
    params: Rc<Params>,
    snapshot: Snapshot,
    // Nodes after the scan, in order.
    chain: Vec<usize>,
    // Per node index: which of its output columns anything later reads.
    needed: Vec<Vec<bool>>,
    chunk_rows: usize,
    segment: usize,
    pos: usize,
    // Rows a limit node still lets through, by position in `chain`.
    remaining: Vec<u64>,
    finished: bool,
    // Rows of the segments already passed, and rows read so far in all.
    passed: u64,
    scanned: u64,
    collector: Collector,
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
            _ => {}
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
            Op::Aggregate { .. } => return Err(EvalError::Unsupported("aggregate")),
            Op::Sort { .. } => return Err(EvalError::Unsupported("sort")),
        }
    }
    Ok(())
}

impl Collector {
    fn new(types: Vec<Type>) -> Collector {
        // Purpose: an empty collector for columns of these types
        let n = types.len();
        Collector { types, values: (0..n).map(|_| None).collect(), valid: (0..n).map(|_| None).collect(), rows: 0 }
    }

    fn add(&mut self, batch: Batch<'_>, rows: usize) {
        // Purpose: append a dense batch's rows to the result
        for (c, column) in batch.columns.into_iter().enumerate() {
            let Some(vector) = column else { continue };
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
        let types = plan.output.iter().map(|f| f.ty).collect();
        Ok(Run {
            plan,
            params,
            snapshot,
            chain,
            needed,
            chunk_rows: chunk_rows.max(1),
            segment: 0,
            pos: 0,
            remaining,
            finished: false,
            passed: 0,
            scanned: 0,
            collector: Collector::new(types),
        })
    }

    pub fn rows_scanned(&self) -> u64 {
        // Purpose: table rows read so far
        self.scanned
    }

    pub fn is_finished(&self) -> bool {
        // Purpose: whether the run has read everything it needs
        self.finished
    }

    pub fn step(&mut self) -> Result<bool, EvalError> {
        // Purpose: process one chunk (or finish); true once the run is complete
        if self.finished {
            return Ok(true);
        }
        // Skip past exhausted (or empty) segments.
        while self.segment < self.snapshot.segments.len() && self.pos >= self.snapshot.segments[self.segment].rows as usize {
            self.passed += self.snapshot.segments[self.segment].rows as u64;
            self.segment += 1;
            self.pos = 0;
        }
        if self.segment >= self.snapshot.segments.len() {
            self.finished = true;
            return Ok(true);
        }
        let view = self.snapshot.segments[self.segment].clone();
        let start = self.pos;
        let rows = (view.rows as usize - start).min(self.chunk_rows);
        let types: Vec<Type> = self.plan.input.iter().map(|f| f.ty).collect();
        let plan = Rc::clone(&self.plan);
        let params = Rc::clone(&self.params);
        let mut batch = Batch::from_view(&view, &types, start, rows);
        prune(&mut batch, &self.needed[0]);
        let mut stage = Stage { batch, sel: None, rows };
        let mut limit_done = false;
        for (k, &at) in self.chain.iter().enumerate() {
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
                            None => stage.batch.columns.iter_mut().flatten().for_each(|v| v.truncate(count)),
                        }
                        stage.batch.rows = if stage.sel.is_some() { stage.batch.rows } else { count };
                        stage.rows = count;
                    }
                    prune(&mut stage.batch, &self.needed[at]);
                    if left - count as u64 == 0 {
                        limit_done = true;
                    }
                }
                _ => return Err(EvalError::Internal("operator is not streaming")),
            }
            if stage.rows == 0 {
                break;
            }
        }
        if stage.rows > 0 {
            let (batch, n) = dense(stage);
            self.collector.add(batch, n);
        }
        self.pos += rows;
        self.scanned = self.passed + self.pos as u64;
        if limit_done {
            self.finished = true;
        }
        Ok(self.finished)
    }

    pub fn finish(self) -> Vec<OutColumn> {
        // Purpose: the result columns of a finished run
        self.collector.finish()
    }
}
