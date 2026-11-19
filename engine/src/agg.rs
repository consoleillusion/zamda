// The aggregate operator (T-406): hash group-by with the aggregates of
// docs/CONTRACT.md. It mirrors src/backends/js/aggregate.ts: groups come out in
// order of first occurrence (C-GROUP-ORDER), null keys form one group, -0.0 and
// 0.0 are one group reported as 0.0 and NaN equals NaN (C-NAN-ORDER), float sums
// are Neumaier sums in row order (C-FLOAT-SUM), integer sums raise on overflow
// (C-OVERFLOW), and a group with no values has a null sum, avg, min and max.
//
// Utf8 and dictionary columns reach it as canonical ids (see exec.rs), so equal
// strings have equal ids and ids order like the strings: keys, count_distinct,
// min and max work on them as on integers.

use std::borrow::Cow;

use crate::ir::Aggregate;
use crate::kernels::EvalError;
use crate::types::Type;
use crate::vector::{storage, Data, Scalar, Storage, Values, Vector};

// The rows of a stage an operator reads: `count` rows, through a selection if there is one.
pub struct Rows<'a> {
    pub count: usize,
    pub sel: Option<&'a [u32]>,
}

// Most key columns a group-by takes; the tuple of key words lives on the stack.
const MAX_KEYS: usize = 16;
const EMPTY: u32 = u32::MAX;

pub(crate) fn source(rows: &Rows, i: usize) -> usize {
    // Purpose: the position in the stage's columns of the i-th row in play
    match rows.sel {
        Some(s) => s[i] as usize,
        None => i,
    }
}

fn wide(ty: Type) -> bool {
    // Purpose: whether a key of this type fills 64 bits (so no word value is free to mark null)
    matches!(storage(ty), Storage::I64 | Storage::U64 | Storage::F64)
}

fn canon_f64(x: f64) -> u64 {
    // Purpose: the bits of a float key with -0.0 as 0.0 and every NaN as one NaN
    if x.is_nan() {
        f64::NAN.to_bits()
    } else if x == 0.0 {
        0
    } else {
        x.to_bits()
    }
}

fn canon_f32(x: f32) -> u64 {
    // Purpose: the bits of a float32 key with -0.0 as 0.0 and every NaN as one NaN
    (if x.is_nan() {
        f32::NAN.to_bits()
    } else if x == 0.0 {
        0
    } else {
        x.to_bits()
    }) as u64
}

pub(crate) fn gather_valid(v: &Vector<'_>, rows: &Rows) -> Option<Vec<u8>> {
    // Purpose: validity bytes of the rows in play, None when the vector has no nulls
    match &v.data {
        Data::Col { valid: Some(valid), .. } => Some((0..rows.count).map(|i| valid[source(rows, i)]).collect()),
        _ => None,
    }
}

fn key_words(v: &Vector<'_>, rows: &Rows) -> Vec<u64> {
    // Purpose: each row's key as one 64-bit word that is equal exactly when the keys are equal
    let n = rows.count;
    match &v.data {
        Data::Const(s) => {
            let w = match *s {
                Scalar::I8(x) => x as u8 as u64,
                Scalar::I16(x) => x as u16 as u64,
                Scalar::I32(x) => x as u32 as u64,
                Scalar::I64(x) => x as u64,
                Scalar::U8(x) => x as u64,
                Scalar::U16(x) => x as u64,
                Scalar::U32(x) => x as u64,
                Scalar::U64(x) => x,
                Scalar::F32(x) => canon_f32(x),
                Scalar::F64(x) => canon_f64(x),
            };
            vec![w; n]
        }
        Data::Col { values, .. } => {
            macro_rules! words {
                ($c:expr, $f:expr) => {
                    (0..n).map(|i| $f($c[source(rows, i)])).collect()
                };
            }
            match values {
                Values::I8(c) => words!(c, |x: i8| x as u8 as u64),
                Values::I16(c) => words!(c, |x: i16| x as u16 as u64),
                Values::I32(c) => words!(c, |x: i32| x as u32 as u64),
                Values::I64(c) => words!(c, |x: i64| x as u64),
                Values::U8(c) => words!(c, |x: u8| x as u64),
                Values::U16(c) => words!(c, |x: u16| x as u64),
                Values::U32(c) => words!(c, |x: u32| x as u64),
                Values::U64(c) => words!(c, |x: u64| x),
                Values::F32(c) => words!(c, canon_f32),
                Values::F64(c) => words!(c, canon_f64),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The group table
// ---------------------------------------------------------------------------

struct GroupTable {
    // Words per key tuple: one per key, plus one word of null bits when a key is 64 bits wide.
    w: usize,
    keys: Vec<u64>,
    slots: Vec<u32>,
    groups: usize,
}

fn hash(t: &[u64]) -> u64 {
    // Purpose: mix a key tuple into a slot number
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &x in t {
        h = (h ^ x).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        h ^= h >> 29;
    }
    h
}

impl GroupTable {
    fn new(w: usize) -> GroupTable {
        // Purpose: an empty table for tuples of w words
        GroupTable { w, keys: Vec::new(), slots: vec![EMPTY; 1024], groups: 0 }
    }

    fn grow(&mut self) {
        // Purpose: double the slot array, keeping it at most half full
        let size = self.slots.len() * 2;
        let mask = size - 1;
        let mut slots = vec![EMPTY; size];
        for g in 0..self.groups {
            let mut s = hash(&self.keys[g * self.w..(g + 1) * self.w]) as usize & mask;
            while slots[s] != EMPTY {
                s = (s + 1) & mask;
            }
            slots[s] = g as u32;
        }
        self.slots = slots;
    }

    #[inline]
    fn insert(&mut self, t: &[u64]) -> u32 {
        // Purpose: the group id of a key tuple, adding a group if it is new
        let w = self.w;
        let mask = self.slots.len() - 1;
        let mut s = hash(t) as usize & mask;
        loop {
            let g = self.slots[s];
            if g == EMPTY {
                let id = self.groups as u32;
                self.keys.extend_from_slice(t);
                self.slots[s] = id;
                self.groups += 1;
                if self.groups * 2 > self.slots.len() {
                    self.grow();
                }
                return id;
            }
            let at = g as usize * w;
            if self.keys[at..at + w] == *t {
                return g;
            }
            s = (s + 1) & mask;
        }
    }
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

// A column read into plain 64-bit values, one per row in play.
pub(crate) enum Norm {
    S(Vec<i64>),
    U(Vec<u64>),
    F(Vec<f64>),
}

pub(crate) fn norm(v: &Vector<'_>, rows: &Rows) -> Norm {
    // Purpose: the rows of a numeric vector as i64, u64 or f64 values (floats widen exactly)
    let n = rows.count;
    match &v.data {
        Data::Const(s) => match *s {
            Scalar::I8(x) => Norm::S(vec![x as i64; n]),
            Scalar::I16(x) => Norm::S(vec![x as i64; n]),
            Scalar::I32(x) => Norm::S(vec![x as i64; n]),
            Scalar::I64(x) => Norm::S(vec![x; n]),
            Scalar::U8(x) => Norm::U(vec![x as u64; n]),
            Scalar::U16(x) => Norm::U(vec![x as u64; n]),
            Scalar::U32(x) => Norm::U(vec![x as u64; n]),
            Scalar::U64(x) => Norm::U(vec![x; n]),
            Scalar::F32(x) => Norm::F(vec![x as f64; n]),
            Scalar::F64(x) => Norm::F(vec![x; n]),
        },
        Data::Col { values, .. } => {
            macro_rules! read {
                ($c:expr, $variant:ident, $t:ty) => {
                    Norm::$variant((0..n).map(|i| $c[source(rows, i)] as $t).collect())
                };
            }
            match values {
                Values::I8(c) => read!(c, S, i64),
                Values::I16(c) => read!(c, S, i64),
                Values::I32(c) => read!(c, S, i64),
                Values::I64(c) => read!(c, S, i64),
                Values::U8(c) => read!(c, U, u64),
                Values::U16(c) => read!(c, U, u64),
                Values::U32(c) => read!(c, U, u64),
                Values::U64(c) => read!(c, U, u64),
                Values::F32(c) => read!(c, F, f64),
                Values::F64(c) => read!(c, F, f64),
            }
        }
    }
}

fn order_f(a: f64, b: f64) -> i32 {
    // Purpose: C-NAN-ORDER: NaN is equal to NaN and greater than every number; -0.0 equals 0.0
    if a < b {
        -1
    } else if a > b {
        1
    } else if a == b {
        0
    } else {
        match (a.is_nan(), b.is_nan()) {
            (true, false) => 1,
            (false, true) => -1,
            _ => 0,
        }
    }
}

// Open-addressing set of (group, value) pairs, for count_distinct.
struct PairSet {
    entries: Vec<(u32, u64)>,
    used: Vec<bool>,
    size: usize,
}

impl PairSet {
    fn new() -> PairSet {
        // Purpose: an empty set
        PairSet { entries: vec![(0, 0); 1024], used: vec![false; 1024], size: 0 }
    }

    fn slot(group: u32, value: u64, mask: usize) -> usize {
        // Purpose: first slot to try for a pair
        hash(&[value, group as u64]) as usize & mask
    }

    fn add(&mut self, group: u32, value: u64) -> bool {
        // Purpose: put a pair in the set; true if it was not there
        let mask = self.used.len() - 1;
        let mut s = Self::slot(group, value, mask);
        while self.used[s] {
            if self.entries[s] == (group, value) {
                return false;
            }
            s = (s + 1) & mask;
        }
        self.used[s] = true;
        self.entries[s] = (group, value);
        self.size += 1;
        if self.size * 2 > self.used.len() {
            let old: Vec<(u32, u64)> = self.entries.iter().zip(&self.used).filter(|(_, u)| **u).map(|(e, _)| *e).collect();
            let capacity = self.used.len() * 2;
            self.entries = vec![(0, 0); capacity];
            self.used = vec![false; capacity];
            for (g, v) in old {
                let mut s = Self::slot(g, v, capacity - 1);
                while self.used[s] {
                    s = (s + 1) & (capacity - 1);
                }
                self.used[s] = true;
                self.entries[s] = (g, v);
            }
        }
        true
    }
}

enum Best {
    S(Vec<i64>),
    U(Vec<u64>),
    F(Vec<f64>),
}

enum Acc {
    Count { counts: Vec<u32> },
    Distinct { counts: Vec<u32>, set: PairSet },
    SumInt { total: Vec<i128>, seen: Vec<u8>, lo: i128, hi: i128, ty: Type },
    SumFloat { sum: Vec<f64>, comp: Vec<f64>, seen: Vec<u32>, mean: bool },
    Extreme { best: Best, seen: Vec<u8>, want_max: bool, ty: Type },
}

fn grown<T: Clone>(v: &mut Vec<T>, n: usize, fill: T) {
    // Purpose: make a per-group vector at least n long
    if v.len() < n {
        v.resize(n, fill);
    }
}

fn int_range(ty: Type) -> (i128, i128) {
    // Purpose: the values a 64-bit integer type holds
    match ty {
        Type::Uint64 => (0, u64::MAX as i128),
        _ => (i64::MIN as i128, i64::MAX as i128),
    }
}

impl Acc {
    fn new(agg: &Aggregate, arg_type: Option<Type>) -> Result<Acc, EvalError> {
        // Purpose: the accumulator for one aggregate
        Ok(match (agg.func.as_str(), arg_type) {
            ("count", _) => Acc::Count { counts: Vec::new() },
            ("count_distinct", Some(_)) => Acc::Distinct { counts: Vec::new(), set: PairSet::new() },
            ("sum", Some(t)) if matches!(storage(t), Storage::F32 | Storage::F64) => Acc::SumFloat { sum: Vec::new(), comp: Vec::new(), seen: Vec::new(), mean: false },
            ("sum", Some(_)) => {
                let (lo, hi) = int_range(agg.ty);
                Acc::SumInt { total: Vec::new(), seen: Vec::new(), lo, hi, ty: agg.ty }
            }
            ("avg", Some(_)) => Acc::SumFloat { sum: Vec::new(), comp: Vec::new(), seen: Vec::new(), mean: true },
            ("min" | "max", Some(t)) => {
                let best = match storage(t) {
                    Storage::I8 | Storage::I16 | Storage::I32 | Storage::I64 => Best::S(Vec::new()),
                    Storage::U8 | Storage::U16 | Storage::U32 | Storage::U64 => Best::U(Vec::new()),
                    Storage::F32 | Storage::F64 => Best::F(Vec::new()),
                };
                Acc::Extreme { best, seen: Vec::new(), want_max: agg.func == "max", ty: t }
            }
            _ => return Err(EvalError::Unsupported("an aggregate the engine does not have")),
        })
    }

    fn add(&mut self, arg: Option<&Vector<'_>>, rows: &Rows, ids: &[u32], groups: usize) -> Result<(), EvalError> {
        // Purpose: fold one chunk into the accumulator; `ids[i]` is the group of the i-th row in play
        let n = rows.count;
        let valid = arg.and_then(|a| gather_valid(a, rows));
        let live = |i: usize| valid.as_ref().is_none_or(|v| v[i] != 0);
        match self {
            Acc::Count { counts } => {
                grown(counts, groups, 0);
                for i in 0..n {
                    if arg.is_none() || live(i) {
                        let c = &mut counts[ids[i] as usize];
                        *c = c.wrapping_add(1);
                    }
                }
            }
            Acc::Distinct { counts, set } => {
                grown(counts, groups, 0);
                let a = arg.expect("count_distinct has an argument");
                let words = distinct_words(a, rows);
                for i in 0..n {
                    if live(i) && set.add(ids[i], words[i]) {
                        counts[ids[i] as usize] += 1;
                    }
                }
            }
            Acc::SumInt { total, seen, lo, hi, ty } => {
                grown(total, groups, 0);
                grown(seen, groups, 0);
                let values = norm(arg.expect("sum has an argument"), rows);
                for i in 0..n {
                    if !live(i) {
                        continue;
                    }
                    let x: i128 = match &values {
                        Norm::S(v) => v[i] as i128,
                        Norm::U(v) => v[i] as i128,
                        Norm::F(_) => return Err(EvalError::Internal("integer sum of floats")),
                    };
                    let g = ids[i] as usize;
                    let t = total[g] + x;
                    if t < *lo || t > *hi {
                        return Err(EvalError::Overflow { what: "sum", ty: *ty });
                    }
                    total[g] = t;
                    seen[g] = 1;
                }
            }
            Acc::SumFloat { sum, comp, seen, .. } => {
                grown(sum, groups, 0.0);
                grown(comp, groups, 0.0);
                grown(seen, groups, 0);
                let values = norm(arg.expect("sum has an argument"), rows);
                for i in 0..n {
                    if !live(i) {
                        continue;
                    }
                    let x = match &values {
                        Norm::S(v) => v[i] as f64,
                        Norm::U(v) => v[i] as f64,
                        Norm::F(v) => v[i],
                    };
                    let g = ids[i] as usize;
                    let s = sum[g];
                    let t = s + x;
                    if s.abs() >= x.abs() {
                        comp[g] += (s - t) + x;
                    } else {
                        comp[g] += (x - t) + s;
                    }
                    sum[g] = t;
                    seen[g] += 1;
                }
            }
            Acc::Extreme { best, seen, want_max, .. } => {
                grown(seen, groups, 0);
                let values = norm(arg.expect("min and max have an argument"), rows);
                macro_rules! fold {
                    ($b:expr, $v:expr, $zero:expr, $cmp:expr) => {{
                        grown($b, groups, $zero);
                        for i in 0..n {
                            if !live(i) {
                                continue;
                            }
                            let g = ids[i] as usize;
                            let x = $v[i];
                            if seen[g] == 0 {
                                $b[g] = x;
                                seen[g] = 1;
                            } else {
                                let c: i32 = $cmp(x, $b[g]);
                                if if *want_max { c > 0 } else { c < 0 } {
                                    $b[g] = x;
                                }
                            }
                        }
                    }};
                }
                match (best, &values) {
                    (Best::S(b), Norm::S(v)) => fold!(b, v, 0i64, |x: i64, y: i64| x.cmp(&y) as i32),
                    (Best::U(b), Norm::U(v)) => fold!(b, v, 0u64, |x: u64, y: u64| x.cmp(&y) as i32),
                    (Best::F(b), Norm::F(v)) => fold!(b, v, 0f64, order_f),
                    _ => return Err(EvalError::Internal("min or max over a column of another kind")),
                }
            }
        }
        Ok(())
    }

    fn finish(self, groups: usize, ty: Type) -> Result<Vector<'static>, EvalError> {
        // Purpose: the aggregate's result column, `groups` rows long
        Ok(match self {
            Acc::Count { mut counts } | Acc::Distinct { mut counts, .. } => {
                grown(&mut counts, groups, 0);
                counts.truncate(groups);
                Vector::column(ty, Values::U32(Cow::Owned(counts)), None)
            }
            Acc::SumInt { mut total, mut seen, ty: result, .. } => {
                grown(&mut total, groups, 0);
                grown(&mut seen, groups, 0);
                let values = if result == Type::Uint64 {
                    Values::U64(Cow::Owned(total[..groups].iter().map(|&t| t as u64).collect()))
                } else {
                    Values::I64(Cow::Owned(total[..groups].iter().map(|&t| t as i64).collect()))
                };
                seen.truncate(groups);
                Vector::column(ty, values, Some(Cow::Owned(seen)))
            }
            Acc::SumFloat { mut sum, mut comp, mut seen, mean } => {
                grown(&mut sum, groups, 0.0);
                grown(&mut comp, groups, 0.0);
                grown(&mut seen, groups, 0);
                let out: Vec<f64> = (0..groups)
                    .map(|g| {
                        // A non-finite running sum is already the IEEE answer; the compensation would turn it into NaN.
                        let total = if sum[g].is_finite() { sum[g] + comp[g] } else { sum[g] };
                        if mean && seen[g] > 0 { total / seen[g] as f64 } else { total }
                    })
                    .collect();
                let valid: Vec<u8> = seen[..groups].iter().map(|&s| (s > 0) as u8).collect();
                Vector::column(ty, Values::F64(Cow::Owned(out)), Some(Cow::Owned(valid)))
            }
            Acc::Extreme { best, mut seen, ty: arg_ty, .. } => {
                grown(&mut seen, groups, 0);
                seen.truncate(groups);
                macro_rules! out {
                    ($b:expr, $variant:ident, $t:ty) => {{
                        let mut v = $b;
                        v.resize(groups, Default::default());
                        Values::$variant(Cow::Owned(v.into_iter().map(|x| x as $t).collect()))
                    }};
                }
                let values = match (best, storage(arg_ty)) {
                    (Best::S(b), Storage::I8) => out!(b, I8, i8),
                    (Best::S(b), Storage::I16) => out!(b, I16, i16),
                    (Best::S(b), Storage::I32) => out!(b, I32, i32),
                    (Best::S(b), Storage::I64) => out!(b, I64, i64),
                    (Best::U(b), Storage::U8) => out!(b, U8, u8),
                    (Best::U(b), Storage::U16) => out!(b, U16, u16),
                    (Best::U(b), Storage::U32) => out!(b, U32, u32),
                    (Best::U(b), Storage::U64) => out!(b, U64, u64),
                    (Best::F(b), Storage::F32) => out!(b, F32, f32),
                    (Best::F(b), Storage::F64) => out!(b, F64, f64),
                    _ => return Err(EvalError::Internal("min or max result of another kind")),
                };
                Vector::column(ty, values, Some(Cow::Owned(seen)))
            }
        })
    }
}

fn distinct_words(v: &Vector<'_>, rows: &Rows) -> Vec<u64> {
    // Purpose: one 64-bit word per row that is equal exactly when the values are equal (NaN equals NaN, -0 equals 0)
    key_words(v, rows)
}

// ---------------------------------------------------------------------------
// The operator
// ---------------------------------------------------------------------------

// Columns held in memory: the result of an operator that has run to its end.
pub struct Table {
    pub rows: usize,
    pub columns: Vec<Vector<'static>>,
}

pub struct Aggregator {
    key_types: Vec<Type>,
    agg_types: Vec<Type>,
    // Which keys are 64 bits wide (they carry null bits in the extra word).
    wide: Vec<bool>,
    has_mask: bool,
    table: Option<GroupTable>,
    accs: Vec<Acc>,
    consumed: bool,
}

impl Aggregator {
    pub fn new(key_types: &[Type], aggs: &[Aggregate]) -> Result<Aggregator, EvalError> {
        // Purpose: set up grouping on these key types and the aggregates to compute
        if key_types.len() > MAX_KEYS {
            return Err(EvalError::Unsupported("more than 16 grouping keys"));
        }
        let wide: Vec<bool> = key_types.iter().map(|&t| wide(t)).collect();
        let has_mask = wide.iter().any(|&w| w);
        let table = if key_types.is_empty() { None } else { Some(GroupTable::new(key_types.len() + has_mask as usize)) };
        let accs = aggs.iter().map(|a| Acc::new(a, a.arg.as_ref().map(|e| e.ty))).collect::<Result<Vec<_>, _>>()?;
        Ok(Aggregator { key_types: key_types.to_vec(), agg_types: aggs.iter().map(|a| a.ty).collect(), wide, has_mask, table, accs, consumed: false })
    }

    pub fn consume(&mut self, keys: &[Vector<'_>], args: &[Option<Vector<'_>>], rows: &Rows) -> Result<(), EvalError> {
        // Purpose: fold one chunk in: assign each row to a group, then update every aggregate
        self.consumed = true;
        let n = rows.count;
        let ids: Vec<u32> = match &mut self.table {
            None => vec![0; n],
            Some(table) => {
                let k = keys.len();
                let mut words: Vec<Vec<u64>> = keys.iter().map(|v| key_words(v, rows)).collect();
                let valid: Vec<Option<Vec<u8>>> = keys.iter().map(|v| gather_valid(v, rows)).collect();
                for j in 0..k {
                    if let Some(v) = &valid[j] {
                        let null = if self.wide[j] { 0 } else { u64::MAX };
                        for i in 0..n {
                            if v[i] == 0 {
                                words[j][i] = null;
                            }
                        }
                    }
                }
                let mut ids = Vec::with_capacity(n);
                let mut tuple = [0u64; MAX_KEYS + 1];
                for i in 0..n {
                    for j in 0..k {
                        tuple[j] = words[j][i];
                    }
                    if self.has_mask {
                        let mut mask = 0u64;
                        for j in 0..k {
                            if self.wide[j] && valid[j].as_ref().is_some_and(|v| v[i] == 0) {
                                mask |= 1 << j;
                            }
                        }
                        tuple[k] = mask;
                    }
                    ids.push(table.insert(&tuple[..table.w]));
                }
                ids
            }
        };
        let groups = self.groups();
        for (acc, arg) in self.accs.iter_mut().zip(args) {
            acc.add(arg.as_ref(), rows, &ids, groups)?;
        }
        Ok(())
    }

    fn groups(&self) -> usize {
        // Purpose: how many groups there are now (an aggregate without keys always has one)
        self.table.as_ref().map_or(1, |t| t.groups)
    }

    pub fn finish(self) -> Result<Table, EvalError> {
        // Purpose: the groups: key columns then aggregate columns, one row per group
        let groups = self.groups();
        let mut columns: Vec<Vector<'static>> = Vec::new();
        if let Some(table) = &self.table {
            let w = table.w;
            for (j, &ty) in self.key_types.iter().enumerate() {
                let word = |g: usize| table.keys[g * w + j];
                let null = |g: usize| if self.wide[j] { table.keys[g * w + self.key_types.len()] >> j & 1 == 1 } else { word(g) == u64::MAX };
                let valid: Vec<u8> = (0..groups).map(|g| (!null(g)) as u8).collect();
                let pick = |g: usize| if null(g) { 0 } else { word(g) };
                macro_rules! out {
                    ($variant:ident, $f:expr) => {
                        Values::$variant(Cow::Owned((0..groups).map(|g| $f(pick(g))).collect()))
                    };
                }
                let values = match storage(ty) {
                    Storage::I8 => out!(I8, |x: u64| x as u8 as i8),
                    Storage::I16 => out!(I16, |x: u64| x as u16 as i16),
                    Storage::I32 => out!(I32, |x: u64| x as u32 as i32),
                    Storage::I64 => out!(I64, |x: u64| x as i64),
                    Storage::U8 => out!(U8, |x: u64| x as u8),
                    Storage::U16 => out!(U16, |x: u64| x as u16),
                    Storage::U32 => out!(U32, |x: u64| x as u32),
                    Storage::U64 => out!(U64, |x: u64| x),
                    Storage::F32 => out!(F32, |x: u64| f32::from_bits(x as u32)),
                    Storage::F64 => out!(F64, f64::from_bits),
                };
                columns.push(Vector::column(ty, values, Some(Cow::Owned(valid))));
            }
        }
        for (acc, ty) in self.accs.into_iter().zip(&self.agg_types) {
            columns.push(acc.finish(groups, *ty)?);
        }
        Ok(Table { rows: groups, columns })
    }
}
