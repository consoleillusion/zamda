// The C interface for evaluating expressions (T-404), used by the host and by
// tests: load a plan and its parameters, evaluate one of a node's expressions
// over a range of rows of a snapshot's segment, read the result back.
//
// Operators (T-405 onward) will call `eval` directly; this entry point exists so
// the evaluator can be checked on its own, against the JS executor. It only
// evaluates nodes that read straight from the scan.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use crate::decode::decode_params;
use crate::error::Error;
use crate::eval::{eval, supported, Batch, Params, BATCH_ROWS};
use crate::ir::{Expr, Op, Plan};
use crate::kernels::EvalError;
use crate::store_abi::with_snapshot;
use crate::types::Type;
use crate::vector::Values;

pub(crate) const OVERFLOW: u32 = 301;
pub(crate) const DIVIDE_BY_ZERO: u32 = 302;
pub(crate) const UNSUPPORTED: u32 = 303;
pub(crate) const BAD_LITERAL: u32 = 304;
pub(crate) const MISSING_PARAM: u32 = 305;
pub(crate) const INTERNAL: u32 = 306;
pub(crate) const SCHEMA_MISMATCH: u32 = 307;
pub(crate) const BAD_HANDLE: u32 = 308;
pub(crate) const BAD_ARGUMENT: u32 = 309;
pub(crate) const NEEDS_MAP: u32 = 310;

// The operation names an overflow or division error can carry, by index.
const WHATS: [&str; 10] = ["add", "sub", "mul", "div", "intDiv", "mod", "neg", "abs", "cast", "sum"];

pub(crate) struct EvalResult {
    pub(crate) ty: Type,
    pub(crate) rows: usize,
    pub(crate) values: Values<'static>,
    pub(crate) valid: Option<Vec<u8>>,
}

pub(crate) struct Registry {
    pub(crate) plans: Vec<Option<Rc<Plan>>>,
    pub(crate) params: Vec<Option<Rc<Params>>>,
    pub(crate) results: Vec<Option<EvalResult>>,
    pub(crate) runs: Vec<Option<crate::exec::Run>>,
}

thread_local! {
    pub(crate) static REGISTRY: RefCell<Registry> = const { RefCell::new(Registry { plans: Vec::new(), params: Vec::new(), results: Vec::new(), runs: Vec::new() }) };
    // (code, which operation, which type)
    static LAST: Cell<(u32, u32, u32)> = const { Cell::new((0, 0, 0)) };
}

pub(crate) fn set_error(code: u32, what: u32, ty: u32) -> u32 {
    // Purpose: remember an error for zs_eval_error and friends
    LAST.with(|c| c.set((code, what, ty)));
    code
}

fn plan_error(e: Error) -> u32 {
    // Purpose: remember a decoding or validation error (codes below 200, the position in the second field)
    set_error(e.code as u32, e.at as u32, 0)
}

pub(crate) fn eval_error(e: &EvalError) -> u32 {
    // Purpose: remember an evaluation error with its operation and type
    let what = |w: &str| WHATS.iter().position(|x| *x == w).unwrap_or(0) as u32;
    match e {
        EvalError::Overflow { what: w, ty } => set_error(OVERFLOW, what(w), ty.id() as u32),
        EvalError::DivideByZero { what: w } => set_error(DIVIDE_BY_ZERO, what(w), 0),
        EvalError::Unsupported(_) => set_error(UNSUPPORTED, 0, 0),
        EvalError::BadLiteral => set_error(BAD_LITERAL, 0, 0),
        EvalError::MissingParam(_) => set_error(MISSING_PARAM, 0, 0),
        EvalError::Internal(_) => set_error(INTERNAL, 0, 0),
        EvalError::NeedsMap(_) => set_error(NEEDS_MAP, 0, 0),
    }
}

pub(crate) fn place<T>(slots: &mut Vec<Option<T>>, value: T) -> u32 {
    // Purpose: store a value in the first free slot and return its handle (index + 1)
    if let Some(i) = slots.iter().position(|s| s.is_none()) {
        slots[i] = Some(value);
        return i as u32 + 1;
    }
    slots.push(Some(value));
    slots.len() as u32
}

pub(crate) fn release<T>(slots: &mut [Option<T>], handle: u32) -> u32 {
    // Purpose: free a handle, or report that it was not in use
    match (handle as usize).checked_sub(1).and_then(|i| slots.get_mut(i)) {
        Some(slot) if slot.is_some() => {
            *slot = None;
            0
        }
        _ => set_error(BAD_HANDLE, 0, 0),
    }
}

fn expressions(node: &crate::ir::Node) -> Vec<&Expr> {
    // Purpose: the expressions of a node, in a fixed order: a filter's predicate, a project's columns, a sort's keys, an aggregate's keys then its arguments
    match &node.op {
        Op::Filter { predicate, .. } => vec![predicate],
        Op::Project { exprs, .. } => exprs.iter().collect(),
        Op::Sort { keys, .. } => keys.iter().map(|k| &k.expr).collect(),
        Op::Aggregate { keys, aggs, .. } => keys.iter().chain(aggs.iter().filter_map(|a| a.arg.as_ref())).collect(),
        Op::Scan | Op::Limit { .. } => Vec::new(),
    }
}

fn input_of(op: &Op) -> Option<usize> {
    // Purpose: the node a node reads from
    match op {
        Op::Filter { input, .. } | Op::Project { input, .. } | Op::Aggregate { input, .. } | Op::Sort { input, .. } | Op::Limit { input, .. } => Some(*input),
        Op::Scan => None,
    }
}

#[no_mangle]
pub extern "C" fn zs_eval_error() -> u32 {
    // Purpose: the code of the last failed call in this interface (plan errors 1-123, store errors 201-211, evaluation errors 301-310)
    LAST.with(|c| c.get().0)
}

#[no_mangle]
pub extern "C" fn zs_eval_error_what() -> u32 {
    // Purpose: for an overflow or division error, the operation as an index into ["add", "sub", "mul", "div", "intDiv", "mod", "neg", "abs", "cast", "sum"]; for a plan error, the position
    LAST.with(|c| c.get().1)
}

#[no_mangle]
pub extern "C" fn zs_eval_error_type() -> u32 {
    // Purpose: for an overflow error, the id of the type that overflowed
    LAST.with(|c| c.get().2)
}

#[no_mangle]
pub extern "C" fn zs_plan_load(ptr: *const u8, len: usize) -> u32 {
    // Purpose: decode and validate a plan; returns a handle, 0 on error
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    match crate::load_plan(bytes) {
        Ok(plan) => REGISTRY.with(|r| place(&mut r.borrow_mut().plans, Rc::new(plan))),
        Err(e) => {
            plan_error(e);
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_plan_free(plan: u32) -> u32 {
    // Purpose: free a plan
    REGISTRY.with(|r| release(&mut r.borrow_mut().plans, plan))
}

#[no_mangle]
pub extern "C" fn zs_params_load(plan: u32, ptr: *const u8, len: usize) -> u32 {
    // Purpose: read parameter values for a plan; returns a handle, 0 on error
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let declared = match (plan as usize).checked_sub(1).and_then(|i| r.plans.get(i)).and_then(|p| p.clone()) {
            Some(p) => p,
            None => {
                set_error(BAD_HANDLE, 0, 0);
                return 0;
            }
        };
        match decode_params(bytes, &declared.params) {
            Ok(p) => place(&mut r.params, Rc::new(p)),
            Err(e) => {
                plan_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn zs_params_free(params: u32) -> u32 {
    // Purpose: free parameter values
    REGISTRY.with(|r| release(&mut r.borrow_mut().params, params))
}

#[no_mangle]
pub extern "C" fn zs_expr_count(plan: u32, node: u32) -> i32 {
    // Purpose: how many expressions zs_eval can evaluate for a node (-1 for a bad handle or node)
    REGISTRY.with(|r| {
        let r = r.borrow();
        let plan = (plan as usize).checked_sub(1).and_then(|i| r.plans.get(i)).and_then(|p| p.as_ref());
        match plan.and_then(|p| p.nodes.get(node as usize)) {
            Some(n) => expressions(n).len() as i32,
            None => {
                set_error(BAD_HANDLE, 0, 0);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn zs_expr_supported(plan: u32, node: u32, expr: u32) -> u32 {
    // Purpose: 0 if the engine can evaluate this expression, else 303 (the host then runs the plan on the JS backend)
    REGISTRY.with(|r| {
        let r = r.borrow();
        let found = (plan as usize).checked_sub(1).and_then(|i| r.plans.get(i)).and_then(|p| p.as_ref())
            .and_then(|p| p.nodes.get(node as usize))
            .and_then(|n| expressions(n).get(expr as usize).copied().map(|e| supported(e)));
        match found {
            Some(Ok(())) => 0,
            Some(Err(_)) => set_error(UNSUPPORTED, 0, 0),
            None => set_error(BAD_HANDLE, 0, 0),
        }
    })
}

fn run(plan: &Plan, params: &Params, node: u32, expr: u32, snapshot: u32, segment: u32, start: u32, rows: u32) -> Result<EvalResult, u32> {
    // Purpose: evaluate one expression of one node over rows [start, start + rows) of a segment
    let node = plan.nodes.get(node as usize).ok_or_else(|| set_error(BAD_ARGUMENT, 0, 0))?;
    let input = input_of(&node.op).ok_or_else(|| set_error(BAD_ARGUMENT, 0, 0))?;
    if !matches!(plan.nodes[input].op, Op::Scan) {
        return Err(set_error(BAD_ARGUMENT, 0, 0));
    }
    let exprs = expressions(node);
    let e = exprs.get(expr as usize).ok_or_else(|| set_error(BAD_ARGUMENT, 0, 0))?;
    if rows as usize > BATCH_ROWS {
        return Err(set_error(BAD_ARGUMENT, 0, 0));
    }
    let outcome = with_snapshot(snapshot, |s| {
        let view = s.segments.get(segment as usize).ok_or(crate::store::StoreError::BadSegment)?;
        if (start as u64 + rows as u64) > view.rows as u64 {
            return Ok(Err(set_error(BAD_ARGUMENT, 0, 0)));
        }
        let types: Vec<Type> = plan.input.iter().map(|f| f.ty).collect();
        if view.column_count() != types.len() || (0..types.len()).any(|c| view.column_type(c) != types[c]) {
            return Ok(Err(set_error(SCHEMA_MISMATCH, 0, 0)));
        }
        let batch = Batch::from_view(view, &types, start as usize, rows as usize);
        Ok(match eval(e, &batch, params) {
            Err(err) => Err(eval_error(&err)),
            Ok(v) => {
                let ty = v.ty;
                let (values, valid) = v.into_columns(rows as usize);
                Ok(EvalResult { ty, rows: rows as usize, values: values.into_owned(), valid: valid.map(|c| c.into_owned()) })
            }
        })
    });
    match outcome {
        Ok(inner) => inner,
        Err(e) => Err(set_error(e as u32, 0, 0)),
    }
}

#[no_mangle]
pub extern "C" fn zs_eval(plan: u32, params: u32, node: u32, expr: u32, snapshot: u32, segment: u32, start: u32, rows: u32) -> u32 {
    // Purpose: evaluate expression `expr` of node `node` over `rows` rows from `start` of a snapshot's segment; returns a result handle, 0 on error (zs_eval_error says which)
    let handles = REGISTRY.with(|r| {
        let r = r.borrow();
        let p = (plan as usize).checked_sub(1).and_then(|i| r.plans.get(i)).and_then(|p| p.clone());
        let q = (params as usize).checked_sub(1).and_then(|i| r.params.get(i)).and_then(|p| p.clone());
        (p, q)
    });
    let (Some(plan), Some(params)) = handles else {
        set_error(BAD_HANDLE, 0, 0);
        return 0;
    };
    match run(&plan, &params, node, expr, snapshot, segment, start, rows) {
        Ok(result) => REGISTRY.with(|r| place(&mut r.borrow_mut().results, result)),
        Err(_) => 0,
    }
}

fn with_result<R>(handle: u32, f: impl FnOnce(&EvalResult) -> R) -> Option<R> {
    // Purpose: run `f` on a result
    REGISTRY.with(|r| {
        let r = r.borrow();
        (handle as usize).checked_sub(1).and_then(|i| r.results.get(i)).and_then(|x| x.as_ref()).map(f)
    })
}

#[no_mangle]
pub extern "C" fn zs_result_type(result: u32) -> u32 {
    // Purpose: the type id of a result (255 for a bad handle)
    with_result(result, |r| r.ty.id() as u32).unwrap_or(255)
}

#[no_mangle]
pub extern "C" fn zs_result_rows(result: u32) -> u32 {
    // Purpose: rows in a result
    with_result(result, |r| r.rows as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn zs_result_values(result: u32) -> *const u8 {
    // Purpose: where a result's values start (rows times the type's width bytes)
    with_result(result, |r| r.values.bytes().as_ptr()).unwrap_or(std::ptr::null())
}

#[no_mangle]
pub extern "C" fn zs_result_valid(result: u32) -> *const u8 {
    // Purpose: where a result's validity bytes start, null when no row is null
    with_result(result, |r| r.valid.as_ref().map_or(std::ptr::null(), |v| v.as_ptr())).unwrap_or(std::ptr::null())
}

#[no_mangle]
pub extern "C" fn zs_result_free(result: u32) -> u32 {
    // Purpose: free a result
    REGISTRY.with(|r| release(&mut r.borrow_mut().results, result))
}

#[no_mangle]
pub extern "C" fn zs_params_table(params: u32, index: u32, values: *const u8, bytes: usize, valid: *const u8, entries: usize) -> u32 {
    // Purpose: give lookup table `index` its values (little-endian, one per entry, then one for null rows) and, if some entries are null, one validity byte per entry; 0 on success
    let values = unsafe { std::slice::from_raw_parts(values, bytes) }.to_vec();
    let valid = if valid.is_null() { None } else { Some(unsafe { std::slice::from_raw_parts(valid, entries) }.to_vec()) };
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let Some(Some(slot)) = (params as usize).checked_sub(1).and_then(|i| r.params.get_mut(i)) else {
            return set_error(BAD_HANDLE, 0, 0);
        };
        // Tables are given before any run starts, while only the registry holds the parameters.
        let Some(p) = Rc::get_mut(slot) else {
            return set_error(BAD_ARGUMENT, 0, 0);
        };
        p.tables.insert(index as usize, crate::eval::LookupTable { entries, bytes: values, valid, decoded: std::cell::OnceCell::new() });
        0
    })
}
