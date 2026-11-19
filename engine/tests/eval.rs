// Evaluator checks that the cross-check against JS cannot make: what is
// constant (D-045, D-052), zero-row batches, and what the engine refuses.

use zamda_engine::eval::{eval, supported, Batch, ParamValue, Params};
use zamda_engine::ir::{Expr, ExprKind, InList, Literal};
use zamda_engine::kernels::EvalError;
use zamda_engine::store::Table;
use zamda_engine::types::Type;
use zamda_engine::vector::{Data, Scalar, Values, Vector};

fn field(i: usize, ty: Type) -> Expr {
    // Purpose: a column reference
    Expr { ty, kind: ExprKind::Field(i) }
}

fn lit(v: i64, ty: Type) -> Expr {
    // Purpose: an integer literal of a type
    Expr { ty, kind: ExprKind::Literal(Literal::Int(v)) }
}

fn call(func: &str, args: Vec<Expr>, ty: Type) -> Expr {
    // Purpose: a function call
    Expr { ty, kind: ExprKind::Call { func: func.to_string(), args } }
}

fn uint8_batch<'a>(values: &'a [u8], valid: Option<&'a [u8]>) -> Batch<'a> {
    // Purpose: a batch with one uint8 column
    let col = Vector::column(
        Type::Uint8,
        Values::U8(std::borrow::Cow::Borrowed(values)),
        valid.map(std::borrow::Cow::Borrowed),
    );
    Batch { rows: values.len(), columns: vec![Some(col)], memo: None }
}

fn constant_of(v: &Vector) -> Option<Scalar> {
    // Purpose: the value if the vector is a constant
    match v.data {
        Data::Const(s) => Some(s),
        _ => None,
    }
}

#[test]
fn a_range_test_that_covers_the_type_is_a_constant() {
    // Purpose: D-052: `>= 0` on a uint8 column is true for every row without reading it, and `> 255` is false
    let data = [1u8, 2, 3];
    let batch = uint8_batch(&data, None);
    let p = Params::default();
    let gte0 = call("gte", vec![field(0, Type::Uint8), lit(0, Type::Uint8)], Type::Bool);
    assert_eq!(constant_of(&eval(&gte0, &batch, &p).unwrap()), Some(Scalar::U8(1)));
    let lte255 = call("lte", vec![field(0, Type::Uint8), lit(255, Type::Uint8)], Type::Bool);
    assert_eq!(constant_of(&eval(&lte255, &batch, &p).unwrap()), Some(Scalar::U8(1)));
    let lt0 = call("lt", vec![field(0, Type::Uint8), lit(0, Type::Uint8)], Type::Bool);
    assert_eq!(constant_of(&eval(&lt0, &batch, &p).unwrap()), Some(Scalar::U8(0)));
    let swapped = call("gte", vec![lit(255, Type::Uint8), field(0, Type::Uint8)], Type::Bool);
    assert_eq!(constant_of(&eval(&swapped, &batch, &p).unwrap()), Some(Scalar::U8(1)), "swapped operands: 255 >= x");
    // a boundary that does not cover is a real column
    let gte1 = call("gte", vec![field(0, Type::Uint8), lit(1, Type::Uint8)], Type::Bool);
    assert_eq!(constant_of(&eval(&gte1, &batch, &p).unwrap()), None);
}

#[test]
fn a_nullable_column_is_never_constant() {
    // Purpose: D-052: a null row is neither true nor false, so `>= 0` on a column with nulls is not constant
    let data = [1u8, 2, 3];
    let valid = [1u8, 0, 1];
    let batch = uint8_batch(&data, Some(&valid));
    let gte0 = call("gte", vec![field(0, Type::Uint8), lit(0, Type::Uint8)], Type::Bool);
    let r = eval(&gte0, &batch, &Params::default()).unwrap();
    assert_eq!(constant_of(&r), None);
    assert_eq!(r.valid(), Some(&valid[..]));
}

#[test]
fn and_or_with_a_constant_side() {
    // Purpose: D-045: a decisive constant skips the other side (an overflow there never happens), a neutral one returns the other side
    let data = [200u8, 100];
    let batch = uint8_batch(&data, None);
    let overflowing = call(
        "gt",
        vec![call("add", vec![field(0, Type::Uint8), field(0, Type::Uint8)], Type::Uint8), lit(0, Type::Uint8)],
        Type::Bool,
    );
    let t = Expr { ty: Type::Bool, kind: ExprKind::Literal(Literal::Bool(true)) };
    let f = Expr { ty: Type::Bool, kind: ExprKind::Literal(Literal::Bool(false)) };
    let p = Params::default();
    // the overflowing side alone raises
    assert!(matches!(eval(&overflowing, &batch, &p), Err(EvalError::Overflow { .. })));
    // `x or true` and `x and false` never look at x
    let or_true = call("or", vec![overflowing.clone(), t.clone()], Type::Bool);
    assert_eq!(constant_of(&eval(&or_true, &batch, &p).unwrap()), Some(Scalar::U8(1)));
    let and_false = call("and", vec![f.clone(), overflowing.clone()], Type::Bool);
    assert_eq!(constant_of(&eval(&and_false, &batch, &p).unwrap()), Some(Scalar::U8(0)));
    // `x and true` is x, so it raises
    let and_true = call("and", vec![overflowing, t], Type::Bool);
    assert!(matches!(eval(&and_true, &batch, &p), Err(EvalError::Overflow { .. })));
    // a parameter counts as a constant as well
    let mut params = Params::default();
    params.values.insert("off".into(), ParamValue::Scalar(Literal::Bool(true)));
    let param = Expr { ty: Type::Bool, kind: ExprKind::Param("off".into()) };
    let or_param = call("or", vec![field(0, Type::Uint8), param], Type::Bool);
    assert_eq!(constant_of(&eval(&or_param, &uint8_batch(&data, None), &params).unwrap()), Some(Scalar::U8(1)));
}

#[test]
fn constants_fold_and_still_raise() {
    // Purpose: an expression of constants is computed once and stays constant; it raises exactly when it would over the rows
    let data = [1u8, 2];
    let batch = uint8_batch(&data, None);
    let p = Params::default();
    let sum = call("add", vec![lit(100, Type::Uint8), lit(27, Type::Uint8)], Type::Uint8);
    assert_eq!(constant_of(&eval(&sum, &batch, &p).unwrap()), Some(Scalar::U8(127)));
    let over = call("add", vec![lit(200, Type::Uint8), lit(100, Type::Uint8)], Type::Uint8);
    assert!(matches!(eval(&over, &batch, &p), Err(EvalError::Overflow { what: "add", ty: Type::Uint8 })));
    // over no rows nothing is evaluated, so nothing raises
    let empty = uint8_batch(&[], None);
    let r = eval(&over, &empty, &p).unwrap();
    assert_eq!(constant_of(&r), None);
    let lit_only = eval(&lit(5, Type::Uint8), &empty, &p).unwrap();
    assert_eq!(constant_of(&lit_only), None, "a literal over no rows is an empty column");
    assert!(matches!(&lit_only.data, Data::Col { values, .. } if values.is_empty()));
    let zero = call("div", vec![lit(1, Type::Uint8), lit(0, Type::Uint8)], Type::Float64);
    assert!(matches!(eval(&zero, &batch, &p), Err(EvalError::DivideByZero { what: "div" })));
    assert!(eval(&zero, &empty, &p).is_ok());
}

#[test]
fn a_missing_parameter_is_an_error() {
    // Purpose: a plan that names a parameter the host did not give does not run
    let data = [1u8];
    let batch = uint8_batch(&data, None);
    let param = Expr { ty: Type::Uint8, kind: ExprKind::Param("x".into()) };
    assert_eq!(eval(&param, &batch, &Params::default()).err(), Some(EvalError::MissingParam("x".into())));
    let list = Expr {
        ty: Type::Bool,
        kind: ExprKind::In { arg: Box::new(field(0, Type::Uint8)), list: InList::Param("l".into()) },
    };
    assert_eq!(eval(&list, &batch, &Params::default()).err(), Some(EvalError::MissingParam("l".into())));
}

#[test]
fn strings_and_dates_are_refused_not_guessed() {
    // Purpose: what the engine cannot evaluate yet is reported as unsupported, so the host can run the plan on the JS backend
    for func in ["lower", "upper", "length", "starts_with", "ends_with", "contains", "date_trunc", "extract"] {
        let e = call(func, vec![field(0, Type::Uint8)], Type::Bool);
        assert!(supported(&e).is_err(), "{func}");
        assert!(matches!(eval(&e, &uint8_batch(&[1], None), &Params::default()), Err(EvalError::Unsupported(_))), "{func}");
    }
    let dict = call("eq", vec![field(0, Type::Dictionary), field(0, Type::Dictionary)], Type::Bool);
    assert!(supported(&dict).is_err());
    let is_null = call("is_null", vec![field(0, Type::Dictionary)], Type::Bool);
    assert!(supported(&is_null).is_ok(), "null tests need only codes");
    assert!(supported(&call("add", vec![field(0, Type::Uint8), lit(1, Type::Uint8)], Type::Uint8)).is_ok());
}

#[test]
fn a_table_segment_feeds_the_evaluator_without_copying() {
    // Purpose: a batch over a stored segment borrows its memory, honours the retain trim, and carries validity
    let mut t = Table::new(&[Type::Int32], Some(4)).unwrap();
    t.begin(6).unwrap();
    let p = t.values_ptr(0).unwrap() as *mut i32;
    unsafe { std::ptr::copy_nonoverlapping([10i32, 20, 30, 40, 50, 60].as_ptr(), p, 6) };
    let v = t.valid_ptr(0).unwrap();
    unsafe { std::ptr::copy_nonoverlapping([1u8, 1, 1, 0, 1, 1].as_ptr(), v, 6) };
    t.commit().unwrap();
    let view = &t.segments()[0];
    let batch = Batch::from_view(view, &[Type::Int32], 1, 3);
    let e = call("add", vec![field(0, Type::Int32), lit(1, Type::Int32)], Type::Int32);
    let r = eval(&e, &batch, &Params::default()).unwrap();
    match &r.data {
        Data::Col { values: Values::I32(v), valid } => {
            assert_eq!(&v[1..], &[51, 61], "the value under a null is not defined");
            assert_eq!(valid.as_deref(), Some(&[0u8, 1, 1][..]));
        }
        other => panic!("unexpected {other:?}"),
    }
}
