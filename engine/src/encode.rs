// The encoder, here only so the tests can check that decoding then encoding gives
// the input back byte for byte (one encoding per plan). The engine itself never
// writes plans: the JS side does. Not exported from the WASM module, so it costs no size.

use crate::decode::{IR_VERSION, STANDARD_NAN};
use crate::ir::*;
use crate::types::Field;

struct Writer(Vec<u8>);

impl Writer {
    fn varint(&mut self, mut v: u64) {
        // Purpose: append a varint
        while v >= 128 {
            self.0.push((v & 127) as u8 | 128);
            v >>= 7;
        }
        self.0.push(v as u8);
    }

    fn string(&mut self, s: &str) {
        // Purpose: append a length-prefixed string
        self.varint(s.len() as u64);
        self.0.extend_from_slice(s.as_bytes());
    }

    fn fields(&mut self, fields: &[Field]) {
        // Purpose: append a list of fields
        self.varint(fields.len() as u64);
        for f in fields {
            self.string(&f.name);
            self.0.push(f.ty.id());
        }
    }

    fn literal(&mut self, l: &Literal) {
        // Purpose: append a literal in its one encoding
        match l {
            Literal::Bool(b) => self.0.push(*b as u8),
            Literal::Int(n) => {
                self.0.push(2);
                self.varint(if *n >= 0 { (*n as u64) * 2 } else { ((-*n) as u64) * 2 - 1 });
            }
            Literal::Float(v) => {
                self.0.push(3);
                let bits = if v.is_nan() { STANDARD_NAN } else { v.to_bits() };
                self.0.extend_from_slice(&bits.to_le_bytes());
            }
            Literal::Big { negative, magnitude } => {
                self.0.push(if *negative { 5 } else { 4 });
                self.0.extend_from_slice(&magnitude.to_le_bytes());
            }
            Literal::Str(s) => {
                self.0.push(6);
                self.string(s);
            }
        }
    }

    fn expr(&mut self, e: &Expr) {
        // Purpose: append an expression
        let kind = match &e.kind {
            ExprKind::Field(_) => 0,
            ExprKind::Literal(_) => 1,
            ExprKind::Param(_) => 2,
            ExprKind::Call { .. } => 3,
            ExprKind::Cast(_) => 4,
            ExprKind::In { .. } => 5,
            ExprKind::Lookup { .. } => 6,
        };
        self.0.push(kind);
        self.0.push(e.ty.id());
        match &e.kind {
            ExprKind::Field(i) => self.varint(*i as u64),
            ExprKind::Literal(l) => self.literal(l),
            ExprKind::Param(name) => self.string(name),
            ExprKind::Call { func, args } => {
                self.string(func);
                self.varint(args.len() as u64);
                for a in args {
                    self.expr(a);
                }
            }
            ExprKind::Cast(arg) => self.expr(arg),
            ExprKind::Lookup { arg, table } => {
                self.expr(arg);
                self.varint(*table as u64);
            }
            ExprKind::In { arg, list } => {
                self.expr(arg);
                match list {
                    InList::Values(values) => {
                        self.0.push(0);
                        self.varint(values.len() as u64);
                        for v in values {
                            self.literal(v);
                        }
                    }
                    InList::Param(name) => {
                        self.0.push(1);
                        self.string(name);
                    }
                }
            }
        }
    }

    fn exprs(&mut self, list: &[Expr]) {
        // Purpose: append a list of expressions
        self.varint(list.len() as u64);
        for e in list {
            self.expr(e);
        }
    }

    fn indexes(&mut self, list: &[usize]) {
        // Purpose: append a list of column indexes
        self.varint(list.len() as u64);
        for i in list {
            self.varint(*i as u64);
        }
    }

    fn sort_keys(&mut self, keys: &[SortKey]) {
        // Purpose: append a list of sort keys
        self.varint(keys.len() as u64);
        for k in keys {
            self.0.push(k.descending as u8 | ((k.nulls_first as u8) << 1));
            self.expr(&k.expr);
        }
    }
}

pub fn encode(plan: &Plan) -> Vec<u8> {
    // Purpose: the plan as bytes, in the format of docs/IR-BINARY.md
    let mut w = Writer(vec![0x5a, 0x49, 0x52, 0x01]);
    w.varint(IR_VERSION);
    w.fields(&plan.input);
    w.varint(plan.nodes.len() as u64);
    for node in &plan.nodes {
        let op = match &node.op {
            Op::Scan => 0,
            Op::Filter { .. } => 1,
            Op::Project { .. } => 2,
            Op::Aggregate { .. } => 3,
            Op::Sort { .. } => 4,
            Op::Limit { .. } => 5,
            Op::Join { .. } => 6,
            Op::Window { .. } => 7,
        };
        w.0.push(op);
        w.fields(&node.schema);
        match &node.op {
            Op::Scan => {}
            Op::Filter { input, predicate } => {
                w.varint(*input as u64);
                w.expr(predicate);
            }
            Op::Project { input, exprs } => {
                w.varint(*input as u64);
                w.exprs(exprs);
            }
            Op::Aggregate { input, keys, aggs } => {
                w.varint(*input as u64);
                w.exprs(keys);
                w.varint(aggs.len() as u64);
                for a in aggs {
                    w.string(&a.func);
                    w.0.push(a.ty.id());
                    match &a.arg {
                        None => w.0.push(0),
                        Some(e) => {
                            w.0.push(1);
                            w.expr(e);
                        }
                    }
                }
            }
            Op::Sort { input, keys } => {
                w.varint(*input as u64);
                w.sort_keys(keys);
            }
            Op::Limit { input, count } => {
                w.varint(*input as u64);
                w.varint(*count);
            }
            Op::Join { input, right, left_keys, right_keys, how } => {
                w.varint(*input as u64);
                w.varint(*right as u64);
                w.indexes(left_keys);
                w.indexes(right_keys);
                w.0.push(how.id());
            }
            Op::Window { input, partitions, sorts, functions } => {
                w.varint(*input as u64);
                w.exprs(partitions);
                w.sort_keys(sorts);
                w.varint(functions.len() as u64);
                for f in functions {
                    w.0.push(f.func.id());
                    w.0.push(f.ty.id());
                }
            }
        }
    }
    w.varint(plan.root as u64);
    w.fields(&plan.output);
    w.varint(plan.params.len() as u64);
    for p in &plan.params {
        w.string(&p.name);
        w.0.push(p.ty.id());
        w.0.push(p.list as u8);
    }
    w.0
}
