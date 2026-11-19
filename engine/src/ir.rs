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
    // Engine only (never in a JS plan): the result of a function of one string, looked up by the string's canonical id in a table the host supplies for the run (see docs/IR-BINARY.md).
    Lookup { arg: Box<Expr>, table: usize },
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

// The spellings are part of the binary format: never reorder, only append.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinKind {
    Inner,
    Left,
    Right,
    Full,
}

impl JoinKind {
    pub fn from_id(id: u8) -> Option<JoinKind> {
        // Purpose: the join kind with this id in the binary format, if there is one
        match id {
            0 => Some(JoinKind::Inner),
            1 => Some(JoinKind::Left),
            2 => Some(JoinKind::Right),
            3 => Some(JoinKind::Full),
            _ => None,
        }
    }

    pub fn id(self) -> u8 {
        // Purpose: this join kind's id in the binary format
        self as u8
    }
}

// The spellings are part of the binary format: never reorder, only append.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowFn {
    RowNumber,
    Rank,
    DenseRank,
}

impl WindowFn {
    pub fn from_id(id: u8) -> Option<WindowFn> {
        // Purpose: the window function with this id in the binary format, if there is one
        match id {
            0 => Some(WindowFn::RowNumber),
            1 => Some(WindowFn::Rank),
            2 => Some(WindowFn::DenseRank),
            _ => None,
        }
    }

    pub fn id(self) -> u8 {
        // Purpose: this window function's id in the binary format
        self as u8
    }
}

#[derive(Clone, Debug)]
pub struct WindowFunction {
    pub func: WindowFn,
    pub ty: Type,
}

#[derive(Clone, Debug)]
pub enum Op {
    Scan,
    Filter { input: usize, predicate: Expr },
    Project { input: usize, exprs: Vec<Expr> },
    Aggregate { input: usize, keys: Vec<Expr>, aggs: Vec<Aggregate> },
    Sort { input: usize, keys: Vec<SortKey> },
    Limit { input: usize, count: u64 },
    // D-076/D-077: parsed so the engine can reject them with a structured error; never executed here.
    Join { input: usize, right: usize, left_keys: Vec<usize>, right_keys: Vec<usize>, how: JoinKind },
    Window { input: usize, partitions: Vec<Expr>, sorts: Vec<SortKey>, functions: Vec<WindowFunction> },
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
