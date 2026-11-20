// A session: several runs over the same table share the cost of evaluating a
// boolean expression over a stretch of rows. The four charts of the reference
// dashboard each scan a million rows and filter them on almost the same
// predicate; the Subexpressions they share (the prefix range, the region
// lookup, the name search) are evaluated once per chunk instead of once per
// chart (T-416, D-056). A session holds nothing else: open runs are unaffected,
// and closing it drops the cache.
//
// The cache is sound because the rows it covers never change: a key is the
// segment's identity and offset, the rows of the chunk, a structural encoding
// of the expression and the values of every parameter it reads, plus (for a
// lookup) a hash of the table it reads rather than the table's index, since
// each run builds its own copy. Only boolean results are cached (a comparison
// or logic kernel is the shareable part of a predicate), and only over rows the
// expression sees whole: any transformation of the batch (a selection gather, a
// limit) clears the tag before the batch reaches expression evaluation. Entries
// past the cap are dropped by clearing the cache; nothing is written past the
// rows a run is already allowed to read.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::eval::{ParamValue, Params};
use crate::ir::{Expr, ExprKind, InList, Literal};
use crate::types::Type;
use crate::vector::{Data, Values, Vector};

// Bytes a session may hold; a boolean entry is one byte per row.
pub const CAP_BYTES: usize = 16 * 1024 * 1024;

// FNV-1a; only used to tell lookup tables apart in a cache key, not for security.
fn fnv(bytes: &[u8], seed: u64) -> u64 {
    // Purpose: hash bytes, mixing `seed` in at the start
    let mut h = seed;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

// A boolean result kept for later runs of the session.
#[derive(Clone)]
struct Entry {
    values: Vec<u8>,
    valid: Option<Vec<u8>>,
}

// One session's entries, keyed by the Memo below plus the expression that made them.
pub struct Session {
    entries: HashMap<Vec<u8>, Entry>,
    bytes: usize,
    hits: u64,
    misses: u64,
}

// The rows one cached entry was computed over: a whole chunk of a segment,
// unchanged. Two runs scanning the same table take the same snapshots, so the
// segment id, offset and chunk coordinates repeat across runs.
#[derive(Clone, Copy)]
pub struct MemoKey {
    pub segment: u64,
    pub offset: u64,
    pub start: u64,
    pub rows: u64,
}

// What an expression needs, beside itself and the rows, to know its own value:
// the session to consult and the coordinates of the rows being evaluated.
#[derive(Clone)]
pub struct Memo {
    pub key: MemoKey,
    pub session: Rc<RefCell<Session>>,
}

impl MemoKey {
    // Purpose: the part of a cache key an expression gets before the expression's own bytes
    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.segment.to_le_bytes());
        out.extend_from_slice(&self.offset.to_le_bytes());
        out.extend_from_slice(&self.start.to_le_bytes());
        out.extend_from_slice(&self.rows.to_le_bytes());
    }
}

fn bytes(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u64).to_le_bytes());
    out.extend_from_slice(b);
}

fn lit_key(lit: &Literal, out: &mut Vec<u8>) {
    match lit {
        Literal::Bool(b) => {
            out.push(0);
            out.push(*b as u8);
        }
        Literal::Int(v) => {
            out.push(1);
            out.extend_from_slice(&v.to_le_bytes());
        }
        Literal::Float(v) => {
            out.push(2);
            out.extend_from_slice(&v.to_bits().to_le_bytes());
        }
        Literal::Big { negative, magnitude } => {
            out.push(3);
            out.push(*negative as u8);
            out.extend_from_slice(&magnitude.to_le_bytes());
        }
        Literal::Str(s) => {
            out.push(4);
            bytes(out, s.as_bytes());
        }
    }
}

fn param_key(name: &str, params: &Params, out: &mut Vec<u8>) {
    bytes(out, name.as_bytes());
    match params.values.get(name) {
        None => out.push(0),
        Some(ParamValue::Scalar(l)) => {
            out.push(1);
            lit_key(l, out);
        }
        Some(ParamValue::List(ls)) => {
            out.push(2);
            out.extend_from_slice(&(ls.len() as u64).to_le_bytes());
            for l in ls {
                lit_key(l, out);
            }
        }
    }
}

// The bytes that identify a lookup table's content: the host may rebuild the
// identical table in another run, and equal content must key equal.
pub fn table_salt(entries: usize, bytes_: &[u8], valid: Option<&[u8]>) -> u64 {
    // Purpose: a hash of a lookup table's content, for a cache key
    let mut h = fnv(&(entries as u64).to_le_bytes(), 0xcbf2_9ce4_8422_2325);
    h = fnv(bytes_, h);
    match valid {
        Some(v) => {
            h ^= 0x9e37_79b9_7f4a_7c15;
            fnv(v, h)
        }
        None => h ^ 0x1656_67b1_9e37_79f9,
    }
}

// The bytes an expression adds to a cache key: its structure, the parameters it
// reads (by value) and the content of any lookup table it reads.
pub fn expr_key(e: &Expr, params: &Params, out: &mut Vec<u8>) {
    out.push(e.ty.id());
    match &e.kind {
        ExprKind::Field(i) => {
            out.push(1);
            out.extend_from_slice(&(*i as u64).to_le_bytes());
        }
        ExprKind::Literal(l) => {
            out.push(2);
            lit_key(l, out);
        }
        ExprKind::Param(name) => {
            out.push(3);
            param_key(name, params, out);
        }
        ExprKind::Call { func, args } => {
            out.push(4);
            bytes(out, func.as_bytes());
            out.extend_from_slice(&(args.len() as u64).to_le_bytes());
            for a in args {
                expr_key(a, params, out);
            }
        }
        ExprKind::Cast(a) => {
            out.push(5);
            expr_key(a, params, out);
        }
        ExprKind::In { arg, list } => {
            out.push(6);
            expr_key(arg, params, out);
            match list {
                InList::Values(ls) => {
                    out.push(1);
                    out.extend_from_slice(&(ls.len() as u64).to_le_bytes());
                    for l in ls {
                        lit_key(l, out);
                    }
                }
                InList::Param(name) => {
                    out.push(2);
                    param_key(name, params, out);
                }
            }
        }
        ExprKind::Lookup { arg, table } => {
            out.push(7);
            expr_key(arg, params, out);
            match params.tables.get(table) {
                Some(t) => out.extend_from_slice(&t.salt.to_le_bytes()),
                // No such table: the lookup would raise anyway; the key only has to be stable.
                None => out.extend_from_slice(&0u64.to_le_bytes()),
            }
        }
    }
}

// Whether an expression reads a column at all; a constant is cheap either way.
pub fn has_field(e: &Expr) -> bool {
    match &e.kind {
        ExprKind::Field(_) => true,
        ExprKind::Literal(_) | ExprKind::Param(_) => false,
        ExprKind::Call { args, .. } => args.iter().any(has_field),
        ExprKind::Cast(a) | ExprKind::Lookup { arg: a, .. } => has_field(a),
        ExprKind::In { arg, .. } => has_field(arg),
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    // Purpose: an empty cache
    pub fn new() -> Self {
        Session { entries: HashMap::new(), bytes: 0, hits: 0, misses: 0 }
    }

    // Purpose: the value an entry holds for the rows it covers, as the vector `eval` would return
    fn into_vector(entry: Entry) -> Vector<'static> {
        Vector::column(
            Type::Bool,
            Values::U8(Cow::Owned(entry.values)),
            entry.valid.map(Cow::Owned),
        )
    }

    // Purpose: the cached value for `key`, or None; counts as a hit or a miss. The rows the entry covers are part of the key, so a hit is always for exactly these rows.
    pub fn get(&mut self, key: &[u8]) -> Option<Vector<'static>> {
        match self.entries.get(key) {
            Some(e) => {
                self.hits += 1;
                Some(Self::into_vector((*e).clone()))
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }

    // Purpose: cache a boolean vector under `key`; drops the whole cache when full (the next misses refill it)
    pub fn put(&mut self, key: Vec<u8>, vector: &Vector<'_>) {
        if vector.ty != Type::Bool {
            return;
        }
        let (values, valid) = match &vector.data {
            Data::Col { values: Values::U8(v), valid } => (v.to_vec(), valid.as_ref().map(|c| c.to_vec())),
            // A constant is cheap to re-evaluate; only materialised columns are worth the rows they take.
            Data::Const(_) | Data::Col { .. } => return,
        };
        let entry = Entry { values, valid };
        let size = entry.values.len() + entry.valid.as_ref().map_or(0, |v| v.len()) + key.len();
        if self.bytes + size > CAP_BYTES {
            self.entries.clear();
            self.bytes = 0;
        }
        self.entries.insert(key, entry);
        self.bytes += size;
    }

    // Purpose: how often a lookup found an entry / did not
    pub fn hits(&self) -> u64 {
        self.hits
    }
    pub fn misses(&self) -> u64 {
        self.misses
    }
}

// A whole cache key for one expression over `rows` of rows described by `memo`.
pub fn cache_key(memo: &MemoKey, expr: &Expr, params: &Params, out: &mut Vec<u8>) {
    out.clear();
    memo.write(out);
    expr_key(expr, params, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(index: usize) -> Expr {
        Expr { ty: Type::Int32, kind: ExprKind::Field(index) }
    }

    fn bool_call(func: &str, args: Vec<Expr>) -> Expr {
        Expr { ty: Type::Bool, kind: ExprKind::Call { func: func.to_string(), args } }
    }

    #[test]
    fn keys_differ_for_different_params() {
        let mut a = Params::default();
        a.values.insert("p".to_string(), ParamValue::Scalar(Literal::Int(1)));
        let mut b = Params::default();
        b.values.insert("p".to_string(), ParamValue::Scalar(Literal::Int(2)));
        let e = bool_call("gte", vec![field(0), Expr { ty: Type::Int32, kind: ExprKind::Param("p".to_string()) }]);
        let (mut ka, mut kb) = (Vec::new(), Vec::new());
        expr_key(&e, &a, &mut ka);
        expr_key(&e, &b, &mut kb);
        assert_ne!(ka, kb);
    }

    #[test]
    fn keys_match_for_equal_params_and_segments() {
        let mut p = Params::default();
        p.values.insert("p".to_string(), ParamValue::Scalar(Literal::Int(1)));
        let e = bool_call("gte", vec![field(0), Expr { ty: Type::Int32, kind: ExprKind::Param("p".to_string()) }]);
        let (mut k1, mut k2) = (Vec::new(), Vec::new());
        expr_key(&e, &p, &mut k1);
        expr_key(&e, &p, &mut k2);
        assert_eq!(k1, k2);
    }

    #[test]
    fn has_field_finds_fields_only_where_present() {
        assert!(has_field(&bool_call("gte", vec![field(0), Expr { ty: Type::Int32, kind: ExprKind::Literal(Literal::Int(1)) }])));
        assert!(!has_field(&bool_call("gte", vec![
            Expr { ty: Type::Int32, kind: ExprKind::Literal(Literal::Int(1)) },
            Expr { ty: Type::Int32, kind: ExprKind::Literal(Literal::Int(2)) },
        ])));
    }

    #[test]
    fn a_session_clears_rather_than_grows_past_the_cap() {
        let mut session = Session::new();
        let entry = Vector::column(Type::Bool, Values::U8(Cow::Owned(vec![1u8; 4])), None);
        session.put(vec![1], &entry);
        assert_eq!(session.entries.len(), 1);
        session.bytes = CAP_BYTES - 1;
        session.put(vec![2], &entry);
        assert_eq!(session.entries.len(), 1, "the cache clears rather than grows past the cap");
    }
}
