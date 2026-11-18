// The IR as the engine holds it after decoding. It mirrors src/ir.ts.

use crate::types::{Field, Type};

#[derive(Clone, Debug)]
pub enum Literal {
    Bool(bool),
    // An integer of magnitude at most 2^52 - 1.
    Int(i64),
    Float(f64),
    // A 64-bit integer: its magnitude, and whether the value is negative (never with magnitude 0).
    Big { negative: bool, magnitude: u64 },
    Str(String),
}

#[derive(Clone, Debug)]
pub enum InList {
    Values(Vec<Literal>),
    Param(String),
}

#[derive(Clone, Debug)]
pub enum ExprKind {
    Field(usize),
    Literal(Literal),
    Param(String),
    Call { func: String, args: Vec<Expr> },
    Cast(Box<Expr>),
    In { arg: Box<Expr>, list: InList },
}

#[derive(Clone, Debug)]
pub struct Expr {
    pub ty: Type,
    pub kind: ExprKind,
}

#[derive(Clone, Debug)]
pub struct Aggregate {
    pub func: String,
    pub ty: Type,
    pub arg: Option<Expr>,
}

#[derive(Clone, Debug)]
pub struct SortKey {
    pub descending: bool,
    pub nulls_first: bool,
    pub expr: Expr,
}

#[derive(Clone, Debug)]
pub enum Op {
    Scan,
    Filter { input: usize, predicate: Expr },
    Project { input: usize, exprs: Vec<Expr> },
    Aggregate { input: usize, keys: Vec<Expr>, aggs: Vec<Aggregate> },
    Sort { input: usize, keys: Vec<SortKey> },
    Limit { input: usize, count: u64 },
}

#[derive(Clone, Debug)]
pub struct Node {
    pub schema: Vec<Field>,
    pub op: Op,
}

#[derive(Clone, Debug)]
pub struct Param {
    pub name: String,
    pub ty: Type,
    pub list: bool,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub version: u64,
    pub input: Vec<Field>,
    pub nodes: Vec<Node>,
    pub root: usize,
    pub output: Vec<Field>,
    pub params: Vec<Param>,
}
