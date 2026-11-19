// The sort operator (T-407). It sorts row indexes, not rows, and the order is a
// total one, so any correct algorithm returns the same permutation as the JS
// executor (src/backends/js/sort.ts): keys in turn, ascending or descending,
// nulls first or last whatever the direction (C-NULL-SORT), NaN greater than
// every number and -0.0 equal to 0.0 (C-NAN-ORDER), strings by canonical id
// (C-STR-ORDER), and rows that tie on every key in input order (C-SORT-STABLE).
// A limit directly after the sort asks for only the first rows of that order.

use std::cmp::Ordering;

use crate::agg::{gather_valid, norm, Norm, Rows};
use crate::ir::SortKey;
use crate::vector::Vector;

struct KeyRows {
    descending: bool,
    nulls_first: bool,
    // One word per row whose unsigned order is the key's ascending order; 0 for null rows.
    words: Vec<u64>,
    // Present once any row of the key has been null: 1 for a value, 0 for null.
    valid: Option<Vec<u8>>,
}

pub struct Sorter {
    keys: Vec<KeyRows>,
    rows: usize,
    limit: Option<usize>,
}

fn order_word_f64(x: f64) -> u64 {
    // Purpose: a float's bits as an unsigned word in numeric order, with NaN last and -0.0 equal to 0.0
    if x.is_nan() {
        return u64::MAX;
    }
    let bits = if x == 0.0 { 0 } else { x.to_bits() };
    if bits >> 63 == 1 { !bits } else { bits | (1 << 63) }
}

fn words_of(v: &Vector<'_>, n: usize) -> Vec<u64> {
    // Purpose: each row's key as a word whose unsigned order is the key's order
    let rows = Rows { count: n, sel: None };
    match norm(v, &rows) {
        Norm::S(x) => x.into_iter().map(|x| (x as u64) ^ (1 << 63)).collect(),
        Norm::U(x) => x,
        Norm::F(x) => x.into_iter().map(order_word_f64).collect(),
    }
}

impl Sorter {
    pub fn new(keys: &[SortKey], limit: Option<usize>) -> Sorter {
        // Purpose: a sorter for these keys; `limit` is how many rows from the front of the order anything needs
        Sorter {
            keys: keys.iter().map(|k| KeyRows { descending: k.descending, nulls_first: k.nulls_first, words: Vec::new(), valid: None }).collect(),
            rows: 0,
            limit,
        }
    }

    pub fn consume(&mut self, keys: &[Vector<'_>], n: usize) {
        // Purpose: take the key values of the next n rows
        for (acc, v) in self.keys.iter_mut().zip(keys) {
            acc.words.extend(words_of(v, n));
            match (&mut acc.valid, gather_valid(v, &Rows { count: n, sel: None })) {
                (Some(all), Some(valid)) => all.extend(valid),
                (Some(all), None) => all.resize(self.rows + n, 1),
                (slot @ None, Some(valid)) => {
                    let mut all = vec![1u8; self.rows];
                    all.extend(valid);
                    *slot = Some(all);
                }
                (None, None) => {}
            }
        }
        self.rows += n;
    }

    pub fn finish(self) -> Vec<u32> {
        // Purpose: row numbers in sorted order (only the first `limit` of them if there is a limit)
        let n = self.rows;
        let mut keys = self.keys;
        // Null rows all get word 0, so they tie; descending keys are inverted so every key sorts ascending.
        for k in keys.iter_mut() {
            for (i, w) in k.words.iter_mut().enumerate() {
                if k.valid.as_ref().is_some_and(|v| v[i] == 0) {
                    *w = 0;
                } else if k.descending {
                    *w = !*w;
                }
            }
        }
        // Null rows sort before every value or after every value, whatever the direction.
        let rank = |k: &KeyRows, i: usize| -> u8 {
            match &k.valid {
                Some(v) if v[i] == 0 => if k.nulls_first { 0 } else { 2 },
                _ => 1,
            }
        };
        let mut order: Vec<u32> = (0..n as u32).collect();
        let limit = self.limit.filter(|&l| l < n);
        if limit == Some(0) {
            return Vec::new();
        }
        if keys.len() == 1 {
            let k = &keys[0];
            let mut tagged: Vec<(u8, u64, u32)> = order.iter().map(|&i| (rank(k, i as usize), k.words[i as usize], i)).collect();
            match limit {
                Some(l) => {
                    tagged.select_nth_unstable(l - 1);
                    tagged.truncate(l);
                }
                None => {}
            }
            tagged.sort_unstable();
            return tagged.into_iter().map(|(_, _, i)| i).collect();
        }
        let compare = |&a: &u32, &b: &u32| -> Ordering {
            for k in keys.iter() {
                let (ra, rb) = (rank(k, a as usize), rank(k, b as usize));
                let c = ra.cmp(&rb).then_with(|| k.words[a as usize].cmp(&k.words[b as usize]));
                if c != Ordering::Equal {
                    return c;
                }
            }
            a.cmp(&b)
        };
        if let Some(l) = limit {
            order.select_nth_unstable_by(l - 1, compare);
            order.truncate(l);
        }
        order.sort_unstable_by(compare);
        order
    }
}
