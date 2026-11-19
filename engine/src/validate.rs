// The IR validator: the Rust twin of src/validate.ts. The engine treats every plan
// as untrusted, so it re-checks what the JS side has already checked. tests/corpus.rs
// runs both on the same plans and requires the same verdict.

use crate::error::{fail, Code, Error};
use crate::ir::*;
use crate::signatures::{CAN_CAST, FUNCTIONS};
use crate::types::{Field, Type};

pub const MAX_NODES: usize = 1024;
pub const MAX_EXPR_DEPTH: usize = 256;
pub const MAX_LIST_VALUES: usize = 65536;

fn depth(e: &Expr) -> usize {
    // Purpose: nesting depth of an expression, for the depth limit
    match &e.kind {
        ExprKind::Cast(arg) => depth(arg) + 1,
        ExprKind::In { arg, .. } => depth(arg) + 1,
        ExprKind::Lookup { arg, .. } => depth(arg) + 1,
        ExprKind::Call { args, .. } => args.iter().map(depth).max().unwrap_or(0) + 1,
        _ => 1,
    }
}

fn check_param(name: &str, ty: Type, list: bool, params: &[Param], node: usize) -> Result<(), Error> {
    // Purpose: a parameter reference must match a declared parameter in type and kind
    match params.iter().find(|p| p.name == name) {
        None => fail(Code::ParamUndeclared, node),
        Some(p) if p.list != list || p.ty != ty => fail(Code::ParamMismatch, node),
        Some(_) => Ok(()),
    }
}

fn check_expr(e: &Expr, input: &[Field], params: &[Param], node: usize) -> Result<(), Error> {
    // Purpose: check field references, function names, casts and result types in one expression, parents first
    match &e.kind {
        ExprKind::Field(index) => match input.get(*index) {
            None => fail(Code::FieldOutOfRange, node),
            Some(f) if f.ty != e.ty => fail(Code::FieldTypeMismatch, node),
            Some(_) => Ok(()),
        },
        ExprKind::Literal(_) => Ok(()),
        ExprKind::Param(name) => check_param(name, e.ty, false, params, node),
        ExprKind::Call { func, args } => {
            let def = match FUNCTIONS.iter().find(|f| f.name == func) {
                Some(d) => d,
                None => return fail(Code::UnknownFunction, node),
            };
            if def.aggregate {
                return fail(Code::WrongFunctionKind, node);
            }
            let arg_types: Vec<Type> = args.iter().map(|a| a.ty).collect();
            match def.signatures.iter().find(|(types, _)| *types == arg_types.as_slice()) {
                None => return fail(Code::NoSignature, node),
                Some((_, result)) if *result != e.ty => return fail(Code::ResultTypeMismatch, node),
                Some(_) => {}
            }
            for a in args {
                check_expr(a, input, params, node)?;
            }
            Ok(())
        }
        ExprKind::Cast(arg) => {
            if !CAN_CAST[arg.ty.id() as usize][e.ty.id() as usize] {
                return fail(Code::BadCast, node);
            }
            check_expr(arg, input, params, node)
        }
        ExprKind::Lookup { arg, .. } => {
            // A table indexed by string id, giving something that is not a string.
            if !matches!(arg.ty, Type::Utf8 | Type::Dictionary) || matches!(e.ty, Type::Utf8 | Type::Dictionary) {
                return fail(Code::LookupBadType, node);
            }
            check_expr(arg, input, params, node)
        }
        ExprKind::In { arg, list } => {
            if e.ty != Type::Bool {
                return fail(Code::InNotBool, node);
            }
            match list {
                InList::Values(values) if values.len() > MAX_LIST_VALUES => return fail(Code::InListTooLong, node),
                InList::Values(_) => {}
                InList::Param(name) => check_param(name, arg.ty, true, params, node)?,
            }
            check_expr(arg, input, params, node)
        }
    }
}

fn check_exprs(exprs: &[&Expr], input: &[Field], params: &[Param], node: usize) -> Result<(), Error> {
    // Purpose: depth-limit and check every expression a node holds
    for e in exprs {
        if depth(e) > MAX_EXPR_DEPTH {
            return fail(Code::ExprTooDeep, node);
        }
        check_expr(e, input, params, node)?;
    }
    Ok(())
}

pub fn validate(plan: &Plan) -> Result<(), Error> {
    // Purpose: reject any structurally or type-invalid plan; the same rules as src/validate.ts
    if plan.nodes.is_empty() || plan.nodes.len() > MAX_NODES {
        return fail(Code::NodeCount, 0);
    }
    if !matches!(plan.nodes[0].op, Op::Scan) {
        return fail(Code::FirstNodeNotScan, 0);
    }
    for (i, p) in plan.params.iter().enumerate() {
        if plan.params[..i].iter().any(|q| q.name == p.name) {
            return fail(Code::DuplicateParam, 0);
        }
    }
    for i in 1..plan.nodes.len() {
        let node = &plan.nodes[i];
        let input_index = match &node.op {
            Op::Scan => return fail(Code::LaterScan, i),
            Op::Filter { input, .. } | Op::Project { input, .. } | Op::Aggregate { input, .. } | Op::Sort { input, .. } | Op::Limit { input, .. } => *input,
        };
        if input_index >= i {
            return fail(Code::BadInput, i);
        }
        let input = &plan.nodes[input_index].schema;
        match &node.op {
            Op::Scan | Op::Limit { .. } => {}
            Op::Filter { predicate, .. } => {
                check_exprs(&[predicate], input, &plan.params, i)?;
                if predicate.ty != Type::Bool {
                    return fail(Code::PredicateNotBool, i);
                }
            }
            Op::Project { exprs, .. } => {
                check_exprs(&exprs.iter().collect::<Vec<_>>(), input, &plan.params, i)?;
                if exprs.len() != node.schema.len() {
                    return fail(Code::ProjectSchemaMismatch, i);
                }
            }
            Op::Sort { keys, .. } => {
                check_exprs(&keys.iter().map(|k| &k.expr).collect::<Vec<_>>(), input, &plan.params, i)?;
                if keys.iter().any(|k| k.expr.ty == Type::Bool) {
                    return fail(Code::SortKeyBool, i);
                }
            }
            Op::Aggregate { keys, aggs, .. } => {
                let mut exprs: Vec<&Expr> = keys.iter().collect();
                exprs.extend(aggs.iter().filter_map(|a| a.arg.as_ref()));
                check_exprs(&exprs, input, &plan.params, i)?;
                if keys.len() + aggs.len() != node.schema.len() {
                    return fail(Code::AggregateSchemaMismatch, i);
                }
                for a in aggs {
                    match FUNCTIONS.iter().find(|f| f.name == a.func) {
                        None => return fail(Code::UnknownFunction, i),
                        Some(f) if !f.aggregate => return fail(Code::WrongFunctionKind, i),
                        Some(_) => {}
                    }
                }
            }
        }
    }
    if plan.root >= plan.nodes.len() {
        return fail(Code::RootOutOfRange, 0);
    }
    Ok(())
}
