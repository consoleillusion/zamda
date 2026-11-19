// Scalar kernels: one function per registry function, over whole batches. They
// mirror the JS executor (src/backends/js/kernels*.ts), which defines the
// behaviour: same results, same errors, raised only for rows that are not null.
// Each kernel cites the contract rule it implements (docs/CONTRACT.md).

use std::borrow::Cow;
use std::ops::{Add, Div, Mul, Rem, Sub};

use crate::types::Type;
use crate::vector::{operand, storage, Data, Num, Opd, Scalar, Storage, Values, Vector};
use crate::with_storage;

#[derive(Clone, Debug, PartialEq)]
pub enum EvalError {
    // C-OVERFLOW: the operation and the result type it overflowed.
    Overflow { what: &'static str, ty: Type },
    // C-DIV: an integer division or modulo by zero.
    DivideByZero { what: &'static str },
    // The engine does not run this yet; the host uses the JS backend for the plan.
    Unsupported(&'static str),
    // A literal does not fit its expression's type.
    BadLiteral,
    MissingParam(String),
    Internal(&'static str),
    // A utf8 or dictionary column the plan reads came without a usable map to canonical ids.
    NeedsMap(&'static str),
    // The run's memory passed the limit the host set (T-410).
    OutOfMemory,
}

// ---------------------------------------------------------------------------
// Integer and float traits
// ---------------------------------------------------------------------------

pub trait Int: Num {
    const MIN: i128;
    const MAX: i128;
    fn to_i128(self) -> i128;
    fn from_i128(v: i128) -> Self;
    fn to_f64(self) -> f64;
    fn is_zero(self) -> bool;
    fn add_checked(self, o: Self) -> Option<Self>;
    fn sub_checked(self, o: Self) -> Option<Self>;
    fn mul_checked(self, o: Self) -> Option<Self>;
    fn add_wrapping(self, o: Self) -> Self;
    fn sub_wrapping(self, o: Self) -> Self;
    fn mul_wrapping(self, o: Self) -> Self;
    fn div_checked(self, o: Self) -> Option<Self>;
    fn rem_wrapping(self, o: Self) -> Self;
    fn neg_checked(self) -> Option<Self>;
    fn abs_checked(self) -> Option<Self>;
}

macro_rules! impl_int {
    ($t:ty, signed) => {
        impl_int!(@common $t);
        impl Int for $t {
            impl_int!(@body $t);
            fn neg_checked(self) -> Option<$t> { self.checked_neg() }
            fn abs_checked(self) -> Option<$t> { self.checked_abs() }
        }
    };
    ($t:ty, unsigned) => {
        impl_int!(@common $t);
        impl Int for $t {
            impl_int!(@body $t);
            fn neg_checked(self) -> Option<$t> { (0 as $t).checked_sub(self) }
            fn abs_checked(self) -> Option<$t> { Some(self) }
        }
    };
    (@common $t:ty) => {};
    (@body $t:ty) => {
        const MIN: i128 = <$t>::MIN as i128;
        const MAX: i128 = <$t>::MAX as i128;
        fn to_i128(self) -> i128 { self as i128 }
        fn from_i128(v: i128) -> $t { v as $t }
        fn to_f64(self) -> f64 { self as f64 }
        fn is_zero(self) -> bool { self == 0 }
        fn add_checked(self, o: $t) -> Option<$t> { self.checked_add(o) }
        fn sub_checked(self, o: $t) -> Option<$t> { self.checked_sub(o) }
        fn mul_checked(self, o: $t) -> Option<$t> { self.checked_mul(o) }
        fn add_wrapping(self, o: $t) -> $t { self.wrapping_add(o) }
        fn sub_wrapping(self, o: $t) -> $t { self.wrapping_sub(o) }
        fn mul_wrapping(self, o: $t) -> $t { self.wrapping_mul(o) }
        fn div_checked(self, o: $t) -> Option<$t> { self.checked_div(o) }
        fn rem_wrapping(self, o: $t) -> $t { self.wrapping_rem(o) }
    };
}

impl_int!(i8, signed);
impl_int!(i16, signed);
impl_int!(i32, signed);
impl_int!(i64, signed);
impl_int!(u8, unsigned);
impl_int!(u16, unsigned);
impl_int!(u32, unsigned);
impl_int!(u64, unsigned);

pub trait Flt: Num + Add<Output = Self> + Sub<Output = Self> + Mul<Output = Self> + Div<Output = Self> + Rem<Output = Self> {
    fn neg_(self) -> Self;
    fn abs_(self) -> Self;
    fn floor_(self) -> Self;
    fn ceil_(self) -> Self;
    fn round_even(self) -> Self;
    fn is_nan_(self) -> bool;
}

macro_rules! impl_flt {
    ($t:ty) => {
        impl Flt for $t {
            fn neg_(self) -> $t { -self }
            fn abs_(self) -> $t { self.abs() }
            fn floor_(self) -> $t { self.floor() }
            fn ceil_(self) -> $t { self.ceil() }
            fn round_even(self) -> $t { self.round_ties_even() }
            fn is_nan_(self) -> bool { self.is_nan() }
        }
    };
}
impl_flt!(f32);
impl_flt!(f64);

// ---------------------------------------------------------------------------
// Looping helpers
// ---------------------------------------------------------------------------

#[inline(always)]
fn each<T: Copy, R: Copy>(x: Opd<T>, y: Opd<T>, n: usize, f: impl Fn(T, T) -> R) -> Vec<R> {
    // Purpose: apply `f` to every row of two operands, with the operand shapes resolved outside the loop
    match (x, y) {
        (Opd::Col(a), Opd::Col(b)) => a[..n].iter().zip(&b[..n]).map(|(&p, &q)| f(p, q)).collect(),
        (Opd::Col(a), Opd::Const(c)) => a[..n].iter().map(|&p| f(p, c)).collect(),
        (Opd::Const(c), Opd::Col(b)) => b[..n].iter().map(|&q| f(c, q)).collect(),
        (Opd::Const(p), Opd::Const(q)) => vec![f(p, q); n],
    }
}

#[inline(always)]
fn each_valid<T: Copy, R: Copy + Default>(
    x: Opd<T>,
    y: Opd<T>,
    n: usize,
    valid: Option<&[u8]>,
    f: impl Fn(T, T) -> Result<R, EvalError>,
) -> Result<Vec<R>, EvalError> {
    // Purpose: apply a fallible `f` to the rows that are not null, first failure in row order wins; null rows get a default
    let mut out = vec![R::default(); n];
    match valid {
        None => match (x, y) {
            (Opd::Col(a), Opd::Col(b)) => {
                for i in 0..n {
                    out[i] = f(a[i], b[i])?;
                }
            }
            (Opd::Col(a), Opd::Const(c)) => {
                for i in 0..n {
                    out[i] = f(a[i], c)?;
                }
            }
            (Opd::Const(c), Opd::Col(b)) => {
                for i in 0..n {
                    out[i] = f(c, b[i])?;
                }
            }
            (Opd::Const(p), Opd::Const(q)) => {
                let r = f(p, q)?;
                out.fill(r);
            }
        },
        Some(v) => {
            for i in 0..n {
                if v[i] != 0 {
                    out[i] = f(x.at(i), y.at(i))?;
                }
            }
        }
    }
    Ok(out)
}

pub fn merge_valid<'a>(x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Option<Cow<'a, [u8]>> {
    // Purpose: validity of a result that is null when either input is null
    let take = |v: &Vector<'a>| match &v.data {
        Data::Col { valid, .. } => valid.clone(),
        Data::Const(_) => None,
    };
    match (take(x), take(y)) {
        (None, None) => None,
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (Some(a), Some(b)) => Some(Cow::Owned((0..n).map(|i| a[i] & b[i]).collect())),
    }
}

fn bool_col<'a>(values: Vec<u8>, valid: Option<Cow<'a, [u8]>>) -> Vector<'a> {
    // Purpose: a boolean column
    Vector::column(Type::Bool, Values::U8(Cow::Owned(values)), valid)
}

fn bool_const<'a>(v: bool) -> Vector<'a> {
    // Purpose: a boolean that is the same in every row
    Vector::constant(Type::Bool, Scalar::U8(v as u8))
}

// ---------------------------------------------------------------------------
// Comparison (C-NAN-PREDICATE: NaN is false in every comparison except neq)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cmp {
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
}

impl Cmp {
    fn flipped(self) -> Cmp {
        // Purpose: the operator that gives the same answer with its operands swapped
        match self {
            Cmp::Eq => Cmp::Eq,
            Cmp::Neq => Cmp::Neq,
            Cmp::Lt => Cmp::Gt,
            Cmp::Lte => Cmp::Gte,
            Cmp::Gt => Cmp::Lt,
            Cmp::Gte => Cmp::Lte,
        }
    }
}

fn int_bounds(ty: Type) -> Option<(i64, i64)> {
    // Purpose: the range of an integer type that fits a JS number; 64-bit types and non-integers have none
    match ty {
        Type::Int8 => Some((i8::MIN as i64, i8::MAX as i64)),
        Type::Int16 => Some((i16::MIN as i64, i16::MAX as i64)),
        Type::Int32 => Some((i32::MIN as i64, i32::MAX as i64)),
        Type::Uint8 => Some((0, u8::MAX as i64)),
        Type::Uint16 => Some((0, u16::MAX as i64)),
        Type::Uint32 => Some((0, u32::MAX as i64)),
        _ => None,
    }
}

fn covers(op: Cmp, ty: Type, b: i64) -> Option<bool> {
    // Purpose: D-045/D-052: true or false when every value of an integer type gives the same answer against b, else None
    let (min, max) = int_bounds(ty)?;
    match op {
        Cmp::Gte => if b <= min { Some(true) } else if b > max { Some(false) } else { None },
        Cmp::Lte => if b >= max { Some(true) } else if b < min { Some(false) } else { None },
        Cmp::Gt => if b < min { Some(true) } else if b >= max { Some(false) } else { None },
        Cmp::Lt => if b > max { Some(true) } else if b <= min { Some(false) } else { None },
        _ => None,
    }
}

fn scalar_i64(s: Scalar) -> Option<i64> {
    // Purpose: an integer scalar as i64 (None for 64-bit unsigned and floats)
    match s {
        Scalar::I8(v) => Some(v as i64),
        Scalar::I16(v) => Some(v as i64),
        Scalar::I32(v) => Some(v as i64),
        Scalar::U8(v) => Some(v as i64),
        Scalar::U16(v) => Some(v as i64),
        Scalar::U32(v) => Some(v as i64),
        _ => None,
    }
}

fn compare_typed<'a, T: Num>(op: Cmp, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Vec<u8> {
    // Purpose: compare two operands of one storage class row by row
    let (a, b) = (operand::<T>(x), operand::<T>(y));
    match op {
        Cmp::Eq => each(a, b, n, |p, q| (p == q) as u8),
        Cmp::Neq => each(a, b, n, |p, q| (p != q) as u8),
        Cmp::Lt => each(a, b, n, |p, q| (p < q) as u8),
        Cmp::Lte => each(a, b, n, |p, q| (p <= q) as u8),
        Cmp::Gt => each(a, b, n, |p, q| (p > q) as u8),
        Cmp::Gte => each(a, b, n, |p, q| (p >= q) as u8),
    }
}

pub fn compare<'a>(op: Cmp, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: eq, neq, lt, lte, gt, gte on numbers, booleans, dates and timestamps
    if matches!(x.ty, Type::Utf8 | Type::Dictionary) {
        return Err(EvalError::Unsupported("comparison of strings"));
    }
    // D-052: a range test that covers the column's whole integer type is the same for every row.
    if x.valid().is_none() && y.valid().is_none() {
        let fixed = match (&x.data, &y.data) {
            (_, Data::Const(c)) => scalar_i64(*c).and_then(|b| covers(op, x.ty, b)),
            (Data::Const(c), _) => scalar_i64(*c).and_then(|b| covers(op.flipped(), y.ty, b)),
            _ => None,
        };
        if let Some(v) = fixed {
            return Ok(bool_const(v));
        }
    }
    if let (Data::Const(_), Data::Const(_)) = (&x.data, &y.data) {
        let r = with_storage!(x.ty, T => compare_typed::<T>(op, x, y, 1));
        return Ok(bool_const(r[0] != 0));
    }
    let values = with_storage!(x.ty, T => compare_typed::<T>(op, x, y, n));
    Ok(bool_col(values, merge_valid(x, y, n)))
}

// ---------------------------------------------------------------------------
// Logic (C-NULL-LOGIC: three-valued AND and OR)
// ---------------------------------------------------------------------------

pub fn kleene<'a>(is_and: bool, x: Vector<'a>, y: Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: and, or: a side that is the same in every row decides the result or is neutral; otherwise row by row
    let decisive = if is_and { 0 } else { 1 };
    for (side, other) in [(&x, &y), (&y, &x)] {
        if let Data::Const(Scalar::U8(v)) = side.data {
            return if v == decisive { side.clone() } else { other.clone() };
        }
    }
    let (a, b) = match (operand::<u8>(&x), operand::<u8>(&y)) {
        (Opd::Col(a), Opd::Col(b)) => (a, b),
        _ => unreachable!("constants returned above"),
    };
    if x.valid().is_none() && y.valid().is_none() {
        let out: Vec<u8> = if is_and {
            a[..n].iter().zip(&b[..n]).map(|(&p, &q)| p & q).collect()
        } else {
            a[..n].iter().zip(&b[..n]).map(|(&p, &q)| p | q).collect()
        };
        return bool_col(out, None);
    }
    let (xv, yv) = (x.valid(), y.valid());
    let mut out = vec![0u8; n];
    let mut valid = vec![0u8; n];
    for i in 0..n {
        let av = xv.map_or(1, |v| v[i]);
        let bv = yv.map_or(1, |v| v[i]);
        if av != 0 && bv != 0 {
            out[i] = if is_and { a[i] & b[i] } else { a[i] | b[i] };
            valid[i] = 1;
        } else if (av != 0 && a[i] == decisive) || (bv != 0 && b[i] == decisive) {
            out[i] = decisive;
            valid[i] = 1;
        }
    }
    bool_col(out, Some(Cow::Owned(valid)))
}

pub fn not<'a>(x: Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: logical not; null stays null
    match x.data {
        Data::Const(Scalar::U8(v)) => bool_const(v == 0),
        Data::Col { values: Values::U8(v), valid } => bool_col(v[..n].iter().map(|&b| (b == 0) as u8).collect(), valid),
        _ => unreachable!("not takes a bool"),
    }
}

pub fn is_null<'a>(x: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: 1 where the input is null; the result itself is never null
    match x.valid() {
        None => bool_const(false),
        Some(v) => bool_col(v[..n].iter().map(|&b| (b == 0) as u8).collect(), None),
    }
}

pub fn is_nan<'a>(x: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: 1 where a float value is NaN; null stays null
    fn run<'a, T: Num>(x: &Vector<'a>, n: usize) -> Vector<'a> {
        match operand::<T>(x) {
            Opd::Const(c) => bool_const(c != c),
            Opd::Col(a) => bool_col(a[..n].iter().map(|&v| (v != v) as u8).collect(), x.valid().map(|v| Cow::Owned(v.to_vec()))),
        }
    }
    match storage(x.ty) {
        Storage::F32 => run::<f32>(x, n),
        _ => run::<f64>(x, n),
    }
}

// ---------------------------------------------------------------------------
// Arithmetic (C-OVERFLOW, C-DIV, C-ROUND)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Arith {
    Add,
    Sub,
    Mul,
}

impl Arith {
    fn name(self) -> &'static str {
        // Purpose: the name used in overflow errors
        match self {
            Arith::Add => "add",
            Arith::Sub => "sub",
            Arith::Mul => "mul",
        }
    }
}

fn int_arith<'a, T: Int>(op: Arith, wrapping: bool, ty: Type, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: add, sub, mul on one integer type, checked or (for the explicit wrapping forms) modulo 2^width
    let (a, b) = (operand::<T>(x), operand::<T>(y));
    let valid = merge_valid(x, y, n);
    let values: Vec<T> = if wrapping {
        match op {
            Arith::Add => each(a, b, n, |p, q| p.add_wrapping(q)),
            Arith::Sub => each(a, b, n, |p, q| p.sub_wrapping(q)),
            Arith::Mul => each(a, b, n, |p, q| p.mul_wrapping(q)),
        }
    } else {
        let overflow = EvalError::Overflow { what: op.name(), ty };
        let v = valid.as_deref();
        match op {
            Arith::Add => each_valid(a, b, n, v, |p, q| p.add_checked(q).ok_or_else(|| overflow.clone()))?,
            Arith::Sub => each_valid(a, b, n, v, |p, q| p.sub_checked(q).ok_or_else(|| overflow.clone()))?,
            Arith::Mul => each_valid(a, b, n, v, |p, q| p.mul_checked(q).ok_or_else(|| overflow.clone()))?,
        }
    };
    Ok(Vector::column(ty, T::wrap(Cow::Owned(values)), valid))
}

fn float_arith<'a, T: Flt>(op: Arith, ty: Type, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: add, sub, mul on floats follow IEEE 754 and never raise
    let (a, b) = (operand::<T>(x), operand::<T>(y));
    let values = match op {
        Arith::Add => each(a, b, n, |p, q| p + q),
        Arith::Sub => each(a, b, n, |p, q| p - q),
        Arith::Mul => each(a, b, n, |p, q| p * q),
    };
    Vector::column(ty, T::wrap(Cow::Owned(values)), merge_valid(x, y, n))
}

pub fn arithmetic<'a>(op: Arith, wrapping: bool, ty: Type, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: add, sub, mul and their wrapping forms
    match storage(ty) {
        Storage::F32 => Ok(float_arith::<f32>(op, ty, x, y, n)),
        Storage::F64 => Ok(float_arith::<f64>(op, ty, x, y, n)),
        Storage::I8 => int_arith::<i8>(op, wrapping, ty, x, y, n),
        Storage::I16 => int_arith::<i16>(op, wrapping, ty, x, y, n),
        Storage::I32 => int_arith::<i32>(op, wrapping, ty, x, y, n),
        Storage::I64 => int_arith::<i64>(op, wrapping, ty, x, y, n),
        Storage::U8 => int_arith::<u8>(op, wrapping, ty, x, y, n),
        Storage::U16 => int_arith::<u16>(op, wrapping, ty, x, y, n),
        Storage::U32 => int_arith::<u32>(op, wrapping, ty, x, y, n),
        Storage::U64 => int_arith::<u64>(op, wrapping, ty, x, y, n),
    }
}

fn int_div<'a, T: Int>(x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: C-DIV: integers divide to float64 and raise on a zero divisor
    let valid = merge_valid(x, y, n);
    let values = each_valid(operand::<T>(x), operand::<T>(y), n, valid.as_deref(), |p, q| {
        if q.is_zero() {
            Err(EvalError::DivideByZero { what: "div" })
        } else {
            Ok(p.to_f64() / q.to_f64())
        }
    })?;
    Ok(Vector::column(Type::Float64, Values::F64(Cow::Owned(values)), valid))
}

fn float_div<'a, T: Flt>(ty: Type, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: C-DIV: float division follows IEEE 754
    let values = each(operand::<T>(x), operand::<T>(y), n, |p, q| p / q);
    Vector::column(ty, T::wrap(Cow::Owned(values)), merge_valid(x, y, n))
}

pub fn div<'a>(x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: div
    match storage(x.ty) {
        Storage::F32 => Ok(float_div::<f32>(x.ty, x, y, n)),
        Storage::F64 => Ok(float_div::<f64>(x.ty, x, y, n)),
        Storage::I8 => int_div::<i8>(x, y, n),
        Storage::I16 => int_div::<i16>(x, y, n),
        Storage::I32 => int_div::<i32>(x, y, n),
        Storage::I64 => int_div::<i64>(x, y, n),
        Storage::U8 => int_div::<u8>(x, y, n),
        Storage::U16 => int_div::<u16>(x, y, n),
        Storage::U32 => int_div::<u32>(x, y, n),
        Storage::U64 => int_div::<u64>(x, y, n),
    }
}

fn int_quotient<'a, T: Int>(is_mod: bool, ty: Type, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: C-DIV: int_div truncates toward zero, mod takes the dividend's sign, a zero divisor raises
    let what = if is_mod { "mod" } else { "intDiv" };
    let valid = merge_valid(x, y, n);
    let overflow = EvalError::Overflow { what, ty };
    let values = each_valid(operand::<T>(x), operand::<T>(y), n, valid.as_deref(), |p, q| {
        if q.is_zero() {
            Err(EvalError::DivideByZero { what })
        } else if is_mod {
            Ok(p.rem_wrapping(q))
        } else {
            p.div_checked(q).ok_or_else(|| overflow.clone())
        }
    })?;
    Ok(Vector::column(ty, T::wrap(Cow::Owned(values)), valid))
}

fn float_mod<'a, T: Flt>(ty: Type, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: float mod is the IEEE remainder with the dividend's sign
    let values = each(operand::<T>(x), operand::<T>(y), n, |p, q| p % q);
    Vector::column(ty, T::wrap(Cow::Owned(values)), merge_valid(x, y, n))
}

pub fn modulo<'a>(is_int_div: bool, ty: Type, x: &Vector<'a>, y: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: int_div (is_int_div) and mod
    let m = !is_int_div;
    match storage(ty) {
        Storage::F32 => Ok(float_mod::<f32>(ty, x, y, n)),
        Storage::F64 => Ok(float_mod::<f64>(ty, x, y, n)),
        Storage::I8 => int_quotient::<i8>(m, ty, x, y, n),
        Storage::I16 => int_quotient::<i16>(m, ty, x, y, n),
        Storage::I32 => int_quotient::<i32>(m, ty, x, y, n),
        Storage::I64 => int_quotient::<i64>(m, ty, x, y, n),
        Storage::U8 => int_quotient::<u8>(m, ty, x, y, n),
        Storage::U16 => int_quotient::<u16>(m, ty, x, y, n),
        Storage::U32 => int_quotient::<u32>(m, ty, x, y, n),
        Storage::U64 => int_quotient::<u64>(m, ty, x, y, n),
    }
}

fn int_unary<'a, T: Int>(is_abs: bool, ty: Type, x: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: C-OVERFLOW: neg and abs raise for the minimum signed value
    let what = if is_abs { "abs" } else { "neg" };
    let a = operand::<T>(x);
    let valid = x.valid();
    let mut out: Vec<T> = Vec::with_capacity(n);
    for i in 0..n {
        let v = a.at(i);
        if valid.map_or(false, |m| m[i] == 0) {
            out.push(v);
            continue;
        }
        let r = if is_abs { v.abs_checked() } else { v.neg_checked() };
        out.push(r.ok_or(EvalError::Overflow { what, ty })?);
    }
    Ok(Vector::column(ty, T::wrap(Cow::Owned(out)), x.valid().map(|v| Cow::Owned(v.to_vec()))))
}

fn float_unary<'a, T: Flt>(f: impl Fn(T) -> T, ty: Type, x: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: neg, abs, floor, ceil and round on floats
    let a = operand::<T>(x);
    let out: Vec<T> = (0..n).map(|i| f(a.at(i))).collect();
    Vector::column(ty, T::wrap(Cow::Owned(out)), x.valid().map(|v| Cow::Owned(v.to_vec())))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unary {
    Neg,
    Abs,
    Floor,
    Ceil,
    Round,
}

pub fn unary<'a>(op: Unary, ty: Type, x: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: neg, abs, floor, ceil, round
    macro_rules! float {
        ($T:ty) => {
            Ok(match op {
                Unary::Neg => float_unary::<$T>(|v| v.neg_(), ty, x, n),
                Unary::Abs => float_unary::<$T>(|v| v.abs_(), ty, x, n),
                Unary::Floor => float_unary::<$T>(|v| v.floor_(), ty, x, n),
                Unary::Ceil => float_unary::<$T>(|v| v.ceil_(), ty, x, n),
                Unary::Round => float_unary::<$T>(|v| v.round_even(), ty, x, n),
            })
        };
    }
    macro_rules! int {
        ($T:ty) => {
            match op {
                Unary::Neg => int_unary::<$T>(false, ty, x, n),
                Unary::Abs => int_unary::<$T>(true, ty, x, n),
                _ => Err(EvalError::Internal("rounding an integer")),
            }
        };
    }
    match storage(ty) {
        Storage::F32 => float!(f32),
        Storage::F64 => float!(f64),
        Storage::I8 => int!(i8),
        Storage::I16 => int!(i16),
        Storage::I32 => int!(i32),
        Storage::I64 => int!(i64),
        Storage::U8 => int!(u8),
        Storage::U16 => int!(u16),
        Storage::U32 => int!(u32),
        Storage::U64 => int!(u64),
    }
}

// ---------------------------------------------------------------------------
// Casts (C-CAST: checked conversion between numeric types)
// ---------------------------------------------------------------------------

pub trait CastFrom: Num {
    const FLOAT: bool;
    fn as_f64(self) -> f64;
    fn as_i128(self) -> i128;
}

pub trait CastTo: Num {
    const FLOAT: bool;
    const LO: i128;
    const HI: i128;
    fn from_f64(v: f64) -> Self;
    fn from_i128_(v: i128) -> Self;
}

macro_rules! impl_cast_int {
    ($($t:ty),*) => {$(
        impl CastFrom for $t {
            const FLOAT: bool = false;
            fn as_f64(self) -> f64 { self as f64 }
            fn as_i128(self) -> i128 { self as i128 }
        }
        impl CastTo for $t {
            const FLOAT: bool = false;
            const LO: i128 = <$t>::MIN as i128;
            const HI: i128 = <$t>::MAX as i128;
            fn from_f64(v: f64) -> $t { v as $t }
            fn from_i128_(v: i128) -> $t { v as $t }
        }
    )*};
}
impl_cast_int!(i8, i16, i32, i64, u8, u16, u32, u64);

macro_rules! impl_cast_float {
    ($($t:ty),*) => {$(
        impl CastFrom for $t {
            const FLOAT: bool = true;
            fn as_f64(self) -> f64 { self as f64 }
            fn as_i128(self) -> i128 { 0 }
        }
        impl CastTo for $t {
            const FLOAT: bool = true;
            const LO: i128 = 0;
            const HI: i128 = 0;
            fn from_f64(v: f64) -> $t { v as $t }
            fn from_i128_(_v: i128) -> $t { 0.0 }
        }
    )*};
}
impl_cast_float!(f32, f64);

fn cast_one<S: CastFrom, D: CastTo>(s: S, to: Type) -> Result<D, EvalError> {
    // Purpose: convert one value: floats truncate toward zero, everything is range checked, NaN and infinities are rejected
    let overflow = EvalError::Overflow { what: "cast", ty: to };
    if D::FLOAT {
        // Integers go through f64 first, as the JS executor does, so f32 targets round twice exactly as it does.
        return Ok(D::from_f64(s.as_f64()));
    }
    let v = if S::FLOAT {
        let f = s.as_f64();
        if !f.is_finite() {
            return Err(overflow);
        }
        f.trunc() as i128
    } else {
        s.as_i128()
    };
    if v < D::LO || v > D::HI {
        return Err(overflow);
    }
    Ok(D::from_i128_(v))
}

fn cast_typed<'a, S: CastFrom, D: CastTo>(to: Type, x: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: cast every row that is not null
    let a = operand::<S>(x);
    let valid = x.valid();
    let mut out: Vec<D> = Vec::with_capacity(n);
    for i in 0..n {
        if valid.map_or(false, |m| m[i] == 0) {
            out.push(D::from_i128_(0));
            continue;
        }
        out.push(cast_one::<S, D>(a.at(i), to)?);
    }
    Ok(Vector::column(to, D::wrap(Cow::Owned(out)), x.valid().map(|v| Cow::Owned(v.to_vec()))))
}

pub fn cast<'a>(x: &Vector<'a>, to: Type, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: cast between numeric types
    macro_rules! to_each {
        ($S:ty) => {
            match storage(to) {
                Storage::I8 => cast_typed::<$S, i8>(to, x, n),
                Storage::I16 => cast_typed::<$S, i16>(to, x, n),
                Storage::I32 => cast_typed::<$S, i32>(to, x, n),
                Storage::I64 => cast_typed::<$S, i64>(to, x, n),
                Storage::U8 => cast_typed::<$S, u8>(to, x, n),
                Storage::U16 => cast_typed::<$S, u16>(to, x, n),
                Storage::U32 => cast_typed::<$S, u32>(to, x, n),
                Storage::U64 => cast_typed::<$S, u64>(to, x, n),
                Storage::F32 => cast_typed::<$S, f32>(to, x, n),
                Storage::F64 => cast_typed::<$S, f64>(to, x, n),
            }
        };
    }
    match storage(x.ty) {
        Storage::I8 => to_each!(i8),
        Storage::I16 => to_each!(i16),
        Storage::I32 => to_each!(i32),
        Storage::I64 => to_each!(i64),
        Storage::U8 => to_each!(u8),
        Storage::U16 => to_each!(u16),
        Storage::U32 => to_each!(u32),
        Storage::U64 => to_each!(u64),
        Storage::F32 => to_each!(f32),
        Storage::F64 => to_each!(f64),
    }
}

// ---------------------------------------------------------------------------
// coalesce, if_else
// ---------------------------------------------------------------------------

fn choose_typed<'a, T: Num>(first: &[u8], a: &Vector<'a>, b: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: take row i from `a` where first[i] is 1, else from `b`, with that side's validity
    let (x, y) = (operand::<T>(a), operand::<T>(b));
    let (av, bv) = (a.valid(), b.valid());
    let mut values: Vec<T> = Vec::with_capacity(n);
    let mut valid = vec![1u8; n];
    for i in 0..n {
        if first[i] != 0 {
            values.push(x.at(i));
            valid[i] = av.map_or(1, |v| v[i]);
        } else {
            values.push(y.at(i));
            valid[i] = bv.map_or(1, |v| v[i]);
        }
    }
    Vector::column(a.ty, T::wrap(Cow::Owned(values)), Some(Cow::Owned(valid)))
}

fn choose<'a>(first: &[u8], a: &Vector<'a>, b: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: choose_typed for any storage class
    if matches!(a.ty, Type::Utf8 | Type::Dictionary) {
        return Err(EvalError::Unsupported("coalesce or if_else on strings"));
    }
    Ok(with_storage!(a.ty, T => choose_typed::<T>(first, a, b, n)))
}

pub fn coalesce<'a>(a: Vector<'a>, b: Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: the first argument where it is not null, else the second
    let first: Vec<u8> = match a.valid() {
        None => return Ok(a),
        Some(v) => v[..n].to_vec(),
    };
    choose(&first, &a, &b, n)
}

pub fn if_else<'a>(c: &Vector<'a>, a: Vector<'a>, b: Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: C-IF: the second argument where the condition is true, else the third (also for a null condition)
    match &c.data {
        Data::Const(Scalar::U8(v)) => return Ok(if *v != 0 { a } else { b }),
        _ => {}
    }
    let flags = operand::<u8>(c);
    let valid = c.valid();
    let first: Vec<u8> = (0..n).map(|i| (flags.at(i) != 0 && valid.map_or(true, |m| m[i] != 0)) as u8).collect();
    choose(&first, &a, &b, n)
}

// ---------------------------------------------------------------------------
// in (C-IN: null stays null, NaN never matches, -0 equals 0)
// ---------------------------------------------------------------------------

pub enum Members {
    Ints(Vec<i128>),
    Floats(Vec<f64>),
}

impl Members {
    fn has_int(&self, v: i128) -> bool {
        // Purpose: whether an integer is in the list
        match self {
            Members::Ints(list) => {
                if list.len() <= 8 { list.contains(&v) } else { list.binary_search(&v).is_ok() }
            }
            Members::Floats(_) => false,
        }
    }

    fn has_float(&self, v: f64) -> bool {
        // Purpose: whether a float is in the list (NaN never is; -0 equals 0)
        match self {
            Members::Floats(list) => {
                if list.len() <= 8 {
                    list.contains(&v)
                } else {
                    list.binary_search_by(|p| p.partial_cmp(&v).unwrap_or(std::cmp::Ordering::Less)).is_ok()
                }
            }
            Members::Ints(_) => false,
        }
    }
}

fn in_typed<'a, T: Num>(members: &Members, to_int: impl Fn(T) -> i128, to_f: impl Fn(T) -> f64, float: bool, x: &Vector<'a>, n: usize) -> Vector<'a> {
    // Purpose: membership of every row of one storage class
    let hit = |v: T| -> u8 { (if float { members.has_float(to_f(v)) } else { members.has_int(to_int(v)) }) as u8 };
    match operand::<T>(x) {
        Opd::Const(c) => bool_const(hit(c) != 0),
        Opd::Col(a) => bool_col(a[..n].iter().map(|&v| hit(v)).collect(), x.valid().map(|v| Cow::Owned(v.to_vec()))),
    }
}

pub fn in_list<'a>(members: &Members, x: &Vector<'a>, n: usize) -> Result<Vector<'a>, EvalError> {
    // Purpose: in: 1 where the value equals a list entry
    if matches!(x.ty, Type::Utf8 | Type::Dictionary) {
        return Err(EvalError::Unsupported("in on strings"));
    }
    macro_rules! int {
        ($T:ty) => { in_typed::<$T>(members, |v| v as i128, |v| v as f64, false, x, n) };
    }
    Ok(match storage(x.ty) {
        Storage::I8 => int!(i8),
        Storage::I16 => int!(i16),
        Storage::I32 => int!(i32),
        Storage::I64 => int!(i64),
        Storage::U8 => int!(u8),
        Storage::U16 => int!(u16),
        Storage::U32 => int!(u32),
        Storage::U64 => int!(u64),
        Storage::F32 => in_typed::<f32>(members, |_| 0, |v| v as f64, true, x, n),
        Storage::F64 => in_typed::<f64>(members, |_| 0, |v| v, true, x, n),
    })
}
