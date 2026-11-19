// Expression evaluation over a batch of rows (T-404). `eval` walks an
// expression bottom-up and returns a vector; every argument is evaluated before
// its function runs (so an error in an argument raises whether or not the
// function would have used it), with one exception that the JS executor also
// makes: `and`/`or` with a literal or parameter on one side skip the other side
// when the answer is already decided (D-045).

use std::borrow::Cow;
use std::collections::HashMap;

use crate::ir::{Expr, ExprKind, InList, Literal};
use crate::kernels::*;
use crate::store::View;
use crate::types::Type;
use crate::vector::{storage, Data, Scalar, Storage, Values, Vector};

// Rows per batch: the engine evaluates this many at a time.
pub const BATCH_ROWS: usize = 65_536;

#[derive(Clone, Debug)]
pub enum ParamValue {
    Scalar(Literal),
    List(Vec<Literal>),
}

// What a string-function expression gives for every string: one value per canonical id, then one for a null row.
#[derive(Clone, Debug)]
pub struct LookupTable {
    pub entries: usize,
    pub bytes: Vec<u8>,
    // One byte per entry (1 = a value), None when no entry is null.
    pub valid: Option<Vec<u8>>,
    // A hash of the table's content, for cache keys across runs (session.rs): a rebuilt identical table salts equal.
    pub salt: u64,
    pub decoded: std::cell::OnceCell<Values<'static>>,
}

#[derive(Clone, Debug, Default)]
pub struct Params {
    pub values: HashMap<String, ParamValue>,
    // Lookup tables by the index plans give them.
    pub tables: HashMap<usize, LookupTable>,
}

// The columns an expression may read, for `rows` rows. A column nothing reads is None.
pub struct Batch<'a> {
    pub rows: usize,
    pub columns: Vec<Option<Vector<'a>>>,
    // The rows this batch covers, and the session sharing their results; None once anything gathered or truncated the rows.
    pub memo: Option<crate::session::Memo>,
}

impl<'a> Batch<'a> {
    pub fn from_view(view: &'a View, types: &[Type], start: usize, rows: usize) -> Batch<'a> {
        // Purpose: a batch of rows [start, start + rows) of a segment, borrowing its memory
        let columns = (0..types.len())
            .map(|c| Some(column_vector(view, c, types[c], start, rows)))
            .collect();
        Batch { rows, columns, memo: None }
    }
}

pub fn column_vector<'a>(view: &'a View, col: usize, ty: Type, start: usize, rows: usize) -> Vector<'a> {
    // Purpose: one segment column as a vector over [start, start + rows), without copying
    let end = start + rows;
    let values = match storage(ty) {
        Storage::I8 => Values::I8(Cow::Borrowed(&view.values::<i8>(col)[start..end])),
        Storage::I16 => Values::I16(Cow::Borrowed(&view.values::<i16>(col)[start..end])),
        Storage::I32 => Values::I32(Cow::Borrowed(&view.values::<i32>(col)[start..end])),
        Storage::I64 => Values::I64(Cow::Borrowed(&view.values::<i64>(col)[start..end])),
        Storage::U8 => Values::U8(Cow::Borrowed(&view.values::<u8>(col)[start..end])),
        Storage::U16 => Values::U16(Cow::Borrowed(&view.values::<u16>(col)[start..end])),
        Storage::U32 => Values::U32(Cow::Borrowed(&view.values::<u32>(col)[start..end])),
        Storage::U64 => Values::U64(Cow::Borrowed(&view.values::<u64>(col)[start..end])),
        Storage::F32 => Values::F32(Cow::Borrowed(&view.values::<f32>(col)[start..end])),
        Storage::F64 => Values::F64(Cow::Borrowed(&view.values::<f64>(col)[start..end])),
    };
    let valid = view.valid(col).map(|v| Cow::Borrowed(&v[start..end]));
    Vector::column(ty, values, valid)
}

pub fn scalar_of(lit: &Literal, ty: Type) -> Result<Scalar, EvalError> {
    // Purpose: a literal as a value of the expression's type (the way the JS executor stores it in a typed array)
    let bad = Err(EvalError::BadLiteral);
    let fits = |v: i64, lo: i128, hi: i128| (v as i128) >= lo && (v as i128) <= hi;
    match (lit, storage(ty)) {
        (Literal::Bool(b), Storage::U8) if ty == Type::Bool => Ok(Scalar::U8(*b as u8)),
        (Literal::Int(v), Storage::I8) if fits(*v, i8::MIN as i128, i8::MAX as i128) => Ok(Scalar::I8(*v as i8)),
        (Literal::Int(v), Storage::I16) if fits(*v, i16::MIN as i128, i16::MAX as i128) => Ok(Scalar::I16(*v as i16)),
        (Literal::Int(v), Storage::I32) if fits(*v, i32::MIN as i128, i32::MAX as i128) => Ok(Scalar::I32(*v as i32)),
        (Literal::Int(v), Storage::I64) => Ok(Scalar::I64(*v)),
        (Literal::Int(v), Storage::U8) if ty != Type::Bool && fits(*v, 0, u8::MAX as i128) => Ok(Scalar::U8(*v as u8)),
        (Literal::Int(v), Storage::U16) if fits(*v, 0, u16::MAX as i128) => Ok(Scalar::U16(*v as u16)),
        (Literal::Int(v), Storage::U32) if fits(*v, 0, u32::MAX as i128) => Ok(Scalar::U32(*v as u32)),
        (Literal::Int(v), Storage::U64) if *v >= 0 => Ok(Scalar::U64(*v as u64)),
        (Literal::Int(v), Storage::F32) => Ok(Scalar::F32(*v as f64 as f32)),
        (Literal::Int(v), Storage::F64) => Ok(Scalar::F64(*v as f64)),
        (Literal::Float(v), Storage::F32) => Ok(Scalar::F32(*v as f32)),
        (Literal::Float(v), Storage::F64) => Ok(Scalar::F64(*v)),
        (Literal::Big { negative, magnitude }, Storage::I64) => {
            let v = if *negative { (*magnitude as i128).wrapping_neg() } else { *magnitude as i128 };
            if v >= i64::MIN as i128 && v <= i64::MAX as i128 { Ok(Scalar::I64(v as i64)) } else { bad }
        }
        (Literal::Big { negative: false, magnitude }, Storage::U64) => Ok(Scalar::U64(*magnitude)),
        _ => bad,
    }
}

fn members_of(list: &[Literal], ty: Type) -> Result<Members, EvalError> {
    // Purpose: the entries of an in-list as the values the column is compared against (NaN dropped, -0 as 0, sorted)
    match storage(ty) {
        Storage::F32 | Storage::F64 => {
            let mut v: Vec<f64> = Vec::new();
            for lit in list {
                match lit {
                    Literal::Int(n) => v.push(*n as f64),
                    Literal::Float(f) if !f.is_nan() => v.push(if *f == 0.0 { 0.0 } else { *f }),
                    Literal::Float(_) => {}
                    _ => return Err(EvalError::BadLiteral),
                }
            }
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v.dedup();
            Ok(Members::Floats(v))
        }
        _ => {
            let mut v: Vec<i128> = Vec::new();
            for lit in list {
                match lit {
                    Literal::Bool(b) if ty == Type::Bool => v.push(*b as i128),
                    Literal::Int(n) => v.push(*n as i128),
                    Literal::Big { negative, magnitude } => {
                        let m = *magnitude as i128;
                        v.push(if *negative { -m } else { m });
                    }
                    // A fraction never equals an integer.
                    Literal::Float(_) => {}
                    _ => return Err(EvalError::BadLiteral),
                }
            }
            v.sort();
            v.dedup();
            Ok(Members::Ints(v))
        }
    }
}

fn bool_literal(expr: &Expr, params: &Params) -> Option<bool> {
    // Purpose: the value of a boolean literal or parameter, None for anything that depends on rows
    match &expr.kind {
        ExprKind::Literal(Literal::Bool(b)) => Some(*b),
        ExprKind::Param(name) => match params.values.get(name) {
            Some(ParamValue::Scalar(Literal::Bool(b))) => Some(*b),
            _ => None,
        },
        _ => None,
    }
}

pub fn simplify(expr: &Expr, params: &Params) -> Expr {
    // Purpose: the expression with every `and`/`or` that a directly constant boolean operand (literal or parameter) decides replaced by its answer, so columns only the dropped side reads are never scanned; `call` makes the same shortcut at run time
    let kind = match &expr.kind {
        ExprKind::Call { func, args } => {
            if (func == "and" || func == "or") && args.len() == 2 {
                // Only an operand that is itself a literal or parameter decides (as in `call`): a nested and/or that folds to a constant does not, so which errors a plan raises is the same on every backend.
                let decisive = func == "or";
                for (constant, other) in [(&args[0], &args[1]), (&args[1], &args[0])] {
                    if let Some(v) = bool_literal(constant, params) {
                        return if v == decisive { Expr { ty: expr.ty, kind: ExprKind::Literal(Literal::Bool(decisive)) } } else { simplify(other, params) };
                    }
                }
            }
            let mut folded: Vec<Expr> = args.iter().map(|a| simplify(a, params)).collect();
            if (func == "and" || func == "or") && args.len() == 2 {
                // An operand that only folded to a deciding constant (it was not one already) must not decide here: the run-time shortcut would then skip an operand the other executors evaluate, and a plan could raise on one backend only.
                let decisive = func == "or";
                for i in 0..2 {
                    if matches!(&folded[i].kind, ExprKind::Literal(Literal::Bool(b)) if *b == decisive) {
                        folded[i] = args[i].clone();
                    }
                }
            }
            ExprKind::Call { func: func.clone(), args: folded }
        }
        ExprKind::Cast(a) => ExprKind::Cast(Box::new(simplify(a, params))),
        ExprKind::In { arg, list } => ExprKind::In { arg: Box::new(simplify(arg, params)), list: list.clone() },
        ExprKind::Lookup { arg, table } => ExprKind::Lookup { arg: Box::new(simplify(arg, params)), table: *table },
        other => other.clone(),
    };
    Expr { ty: expr.ty, kind }
}

const UNSUPPORTED_CALLS: [&str; 6] = ["lower", "upper", "length", "starts_with", "ends_with", "contains"];

fn date_unit(args: &[Expr]) -> Option<crate::time::Unit> {
    // Purpose: the unit of a date_trunc or extract call when it is a literal the engine knows for the date argument's type
    match (args.first().map(|a| &a.kind), args.get(1)) {
        (Some(ExprKind::Literal(Literal::Str(name))), Some(x)) => crate::time::unit_of(name, x.ty),
        _ => None,
    }
}

pub fn supported(expr: &Expr) -> Result<(), &'static str> {
    // Purpose: whether the engine can evaluate this expression; the host runs a plan that fails this on the JS backend
    let strings = |t: Type| matches!(t, Type::Utf8 | Type::Dictionary);
    match &expr.kind {
        ExprKind::Field(_) | ExprKind::Literal(_) | ExprKind::Param(_) => Ok(()),
        ExprKind::Cast(a) => {
            supported(a)?;
            Ok(())
        }
        ExprKind::Lookup { arg, .. } => supported(arg),
        ExprKind::In { arg, .. } => {
            supported(arg)?;
            if strings(arg.ty) { Err("in on strings") } else { Ok(()) }
        }
        ExprKind::Call { func, args } if func == "date_trunc" || func == "extract" => {
            // The unit is a string literal that names no column; only the date argument is evaluated.
            if date_unit(args).is_none() || args.len() != 2 {
                return Err("a date unit the engine does not know");
            }
            supported(&args[1])
        }
        ExprKind::Call { func, args } => {
            if let Some(name) = UNSUPPORTED_CALLS.iter().find(|n| **n == func.as_str()) {
                return Err(name);
            }
            for a in args {
                supported(a)?;
            }
            let on_strings = args.iter().any(|a| strings(a.ty));
            if on_strings && func != "is_null" {
                return Err("a function on strings");
            }
            Ok(())
        }
    }
}

pub fn eval<'a>(expr: &Expr, batch: &Batch<'a>, params: &Params) -> Result<Vector<'a>, EvalError> {
    // Purpose: evaluate one expression over a batch; boolean subexpressions may come from the session's cache
    if expr.ty == Type::Bool
        && !matches!(expr.kind, ExprKind::Field(_))
        && crate::session::has_field(expr)
        && batch.memo.is_some()
    {
        let memo = batch.memo.as_ref().expect("checked above");
        let mut key = Vec::with_capacity(96);
        crate::session::cache_key(&memo.key, expr, params, &mut key);
        {
            let mut session = memo.session.borrow_mut();
            if let Some(v) = session.get(&key) {
                return Ok(v);
            }
        }
        // The borrow ends before evaluating: subexpressions borrow the session themselves.
        let value = eval_uncached(expr, batch, params)?;
        memo.session.borrow_mut().put(key, &value);
        return Ok(value);
    }
    eval_uncached(expr, batch, params)
}

fn eval_uncached<'a>(expr: &Expr, batch: &Batch<'a>, params: &Params) -> Result<Vector<'a>, EvalError> {
    // Purpose: evaluate one expression over a batch
    let n = batch.rows;
    match &expr.kind {
        ExprKind::Field(i) => batch
            .columns
            .get(*i)
            .and_then(|c| c.clone())
            .ok_or(EvalError::Internal("a column the plan reads was not loaded")),
        ExprKind::Literal(lit) => {
            if n == 0 { return Ok(empty(expr.ty)); }
            Ok(Vector::constant(expr.ty, scalar_of(lit, expr.ty)?))
        }
        ExprKind::Param(name) => match params.values.get(name) {
            Some(ParamValue::Scalar(lit)) => {
                if n == 0 { return Ok(empty(expr.ty)); }
                Ok(Vector::constant(expr.ty, scalar_of(lit, expr.ty)?))
            }
            _ => Err(EvalError::MissingParam(name.clone())),
        },
        ExprKind::Lookup { arg, table } => lookup(arg, *table, expr.ty, batch, params),
        ExprKind::Cast(arg) => {
            let x = eval(arg, batch, params)?;
            if n == 0 { return Ok(empty(expr.ty)); }
            if matches!(arg.ty, Type::Utf8 | Type::Dictionary | Type::Bool) {
                return Err(EvalError::Unsupported("cast of a non-number"));
            }
            fold(&x, n, |v, rows| cast(v, expr.ty, rows))
        }
        ExprKind::In { arg, list } => {
            let x = eval(arg, batch, params)?;
            if n == 0 { return Ok(empty(Type::Bool)); }
            let members = match list {
                InList::Values(values) => members_of(values, arg.ty)?,
                InList::Param(name) => match params.values.get(name) {
                    Some(ParamValue::List(values)) => members_of(values, arg.ty)?,
                    _ => return Err(EvalError::MissingParam(name.clone())),
                },
            };
            in_list(&members, &x, n)
        }
        ExprKind::Call { func, args } => call(func, args, expr.ty, batch, params),
    }
}

fn empty<'a>(ty: Type) -> Vector<'a> {
    // Purpose: the result over no rows: nothing is evaluated, so nothing can fail
    Vector::column(ty, Values::empty(ty), None)
}

fn fold<'a>(x: &Vector<'a>, n: usize, f: impl Fn(&Vector<'a>, usize) -> Result<Vector<'a>, EvalError>) -> Result<Vector<'a>, EvalError> {
    // Purpose: apply a per-row kernel to one operand; a constant is computed once on one row and stays constant
    if let Data::Const(_) = x.data {
        return f(x, 1).map(one_row_constant);
    }
    f(x, n)
}

fn one_row_constant<'a>(v: Vector<'a>) -> Vector<'a> {
    // Purpose: a one-row result of constant inputs, as a constant
    let ty = v.ty;
    match v.data {
        Data::Col { values, valid: None } => Vector { ty, data: Data::Const(first_scalar(&values)) },
        other => Vector { ty, data: other },
    }
}

fn first_scalar(values: &Values<'_>) -> Scalar {
    // Purpose: the first value of a column as a scalar
    match values {
        Values::I8(v) => Scalar::I8(v[0]),
        Values::I16(v) => Scalar::I16(v[0]),
        Values::I32(v) => Scalar::I32(v[0]),
        Values::I64(v) => Scalar::I64(v[0]),
        Values::U8(v) => Scalar::U8(v[0]),
        Values::U16(v) => Scalar::U16(v[0]),
        Values::U32(v) => Scalar::U32(v[0]),
        Values::U64(v) => Scalar::U64(v[0]),
        Values::F32(v) => Scalar::F32(v[0]),
        Values::F64(v) => Scalar::F64(v[0]),
    }
}

fn fold2<'a>(x: &Vector<'a>, y: &Vector<'a>, n: usize, f: impl Fn(&Vector<'a>, &Vector<'a>, usize) -> Result<Vector<'a>, EvalError>) -> Result<Vector<'a>, EvalError> {
    // Purpose: apply a per-row kernel to two operands; two constants are computed once on one row and stay constant
    if let (Data::Const(_), Data::Const(_)) = (&x.data, &y.data) {
        return f(x, y, 1).map(one_row_constant);
    }
    f(x, y, n)
}

fn call<'a>(func: &str, args: &[Expr], ty: Type, batch: &Batch<'a>, params: &Params) -> Result<Vector<'a>, EvalError> {
    // Purpose: evaluate a function call: logic shortcuts first, then the arguments left to right, then the kernel
    let n = batch.rows;
    if (func == "and" || func == "or") && args.len() == 2 {
        let decisive = func == "or";
        for (constant, other) in [(&args[0], &args[1]), (&args[1], &args[0])] {
            if let Some(v) = bool_literal(constant, params) {
                if n == 0 { return Ok(empty(Type::Bool)); }
                if v == decisive {
                    return Ok(Vector::constant(Type::Bool, Scalar::U8(decisive as u8)));
                }
                return eval(other, batch, params);
            }
        }
    }
    if func == "date_trunc" || func == "extract" {
        let unit = date_unit(args).ok_or(EvalError::Unsupported("a date unit the engine does not know"))?;
        let x = eval(&args[1], batch, params)?;
        if n == 0 {
            return Ok(empty(ty));
        }
        return fold(&x, n, |v, rows| crate::time::date_op(func, unit, ty, v, rows));
    }
    if UNSUPPORTED_CALLS.contains(&func) {
        return Err(EvalError::Unsupported("a string function"));
    }
    let mut v: Vec<Vector<'a>> = Vec::with_capacity(args.len());
    for a in args {
        v.push(eval(a, batch, params)?);
    }
    if n == 0 {
        return Ok(empty(ty));
    }
    let arg_ty = args.first().map(|a| a.ty);
    let cmp = |op: Cmp, v: &[Vector<'a>]| fold2(&v[0], &v[1], n, |a, b, rows| compare(op, a, b, rows));
    let arith = |op: Arith, wrapping: bool, v: &[Vector<'a>]| fold2(&v[0], &v[1], n, |a, b, rows| arithmetic(op, wrapping, ty, a, b, rows));
    match func {
        "eq" => cmp(Cmp::Eq, &v),
        "neq" => cmp(Cmp::Neq, &v),
        "lt" => cmp(Cmp::Lt, &v),
        "lte" => cmp(Cmp::Lte, &v),
        "gt" => cmp(Cmp::Gt, &v),
        "gte" => cmp(Cmp::Gte, &v),
        "and" | "or" => {
            let mut it = v.into_iter();
            let (x, y) = (it.next().unwrap(), it.next().unwrap());
            Ok(kleene(func == "and", x, y, n))
        }
        "not" => fold(&v[0], n, |x, rows| Ok(not(x.clone(), rows))),
        "is_null" => Ok(is_null(&v[0], n)),
        "is_nan" => fold(&v[0], n, |x, rows| Ok(is_nan(x, rows))),
        "add" => arith(Arith::Add, false, &v),
        "sub" => arith(Arith::Sub, false, &v),
        "mul" => arith(Arith::Mul, false, &v),
        "wrapping_add" => arith(Arith::Add, true, &v),
        "wrapping_sub" => arith(Arith::Sub, true, &v),
        "wrapping_mul" => arith(Arith::Mul, true, &v),
        "div" => fold2(&v[0], &v[1], n, |a, b, rows| div(a, b, rows)),
        "int_div" => fold2(&v[0], &v[1], n, |a, b, rows| modulo(true, ty, a, b, rows)),
        "mod" => fold2(&v[0], &v[1], n, |a, b, rows| modulo(false, ty, a, b, rows)),
        "neg" => fold(&v[0], n, |x, rows| unary(Unary::Neg, ty, x, rows)),
        "abs" => fold(&v[0], n, |x, rows| unary(Unary::Abs, ty, x, rows)),
        "floor" => fold(&v[0], n, |x, rows| unary(Unary::Floor, ty, x, rows)),
        "ceil" => fold(&v[0], n, |x, rows| unary(Unary::Ceil, ty, x, rows)),
        "round" => fold(&v[0], n, |x, rows| unary(Unary::Round, ty, x, rows)),
        "coalesce" => {
            let mut it = v.into_iter();
            let (a, b) = (it.next().unwrap(), it.next().unwrap());
            coalesce(a, b, n)
        }
        "if_else" => {
            let mut it = v.into_iter();
            let (c, a, b) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
            if_else(&c, a, b, n)
        }
        _ => {
            let _ = arg_ty;
            Err(EvalError::Unsupported("a function the engine does not have"))
        }
    }
}

fn lookup<'a>(arg: &Expr, table: usize, ty: Type, batch: &Batch<'a>, params: &Params) -> Result<Vector<'a>, EvalError> {
    // Purpose: the table's value for each row's string id (the table's last entry for a null row)
    let t = params.tables.get(&table).ok_or(EvalError::NeedsMap("a lookup table was not given"))?;
    let ids = eval(arg, batch, params)?;
    let n = batch.rows;
    let (values, valid) = ids.into_columns(n);
    let Values::I32(ids) = values else { return Err(EvalError::Internal("a lookup over something other than string ids")) };
    let decoded = t.decoded.get_or_init(|| Values::from_le_bytes(ty, &t.bytes));
    if t.entries == 0 || decoded.len() != t.entries || t.valid.as_ref().is_some_and(|v| v.len() != t.entries) {
        return Err(EvalError::NeedsMap("a lookup table does not match its size"));
    }
    let null_entry = (t.entries - 1) as u32;
    let mut at = Vec::with_capacity(n);
    let mut past_end = false;
    for i in 0..n {
        if valid.as_ref().is_some_and(|v| v[i] == 0) {
            at.push(null_entry);
        } else {
            let id = ids[i] as u32;
            if id >= null_entry { past_end = true; break; }
            at.push(id);
        }
    }
    let out = decoded.gather(&at);
    let out_valid = t.valid.as_ref().map(|v| Cow::Owned(at.iter().map(|&i| v[i as usize]).collect::<Vec<u8>>()));
    if past_end { return Err(EvalError::NeedsMap("a string id is past the end of a lookup table")); }
    Ok(Vector::column(ty, out, out_valid))
}
