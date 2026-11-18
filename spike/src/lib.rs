// Spike kernels for S-301: the spike gate's "grouped aggregate and sort" set (Q1, Q3, Q4, Q7).
//
// Every function takes raw pointers and lengths and writes into buffers the host
// allocated, so the same source runs as a WASM module (pointers are offsets into
// linear memory) and as a native library (pointers are real, called through Bun FFI to get
// an upper bound on what WASM can do). Strings never reach Rust: the host sends dictionary
// codes (0 = null), as zamda's own dictionary columns do.

use std::alloc::{alloc, dealloc, Layout};
use std::slice;

// ---- memory ----

#[no_mangle]
pub extern "C" fn zs_alloc(bytes: usize) -> *mut u8 {
    // Purpose: give the host a block of `bytes` bytes, 8-aligned; the host writes columns into it
    unsafe { alloc(Layout::from_size_align_unchecked(bytes.max(8), 8)) }
}

#[no_mangle]
pub extern "C" fn zs_free(ptr: *mut u8, bytes: usize) {
    // Purpose: return a block from zs_alloc
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(bytes.max(8), 8)) }
}

// ---- overflow-checked counting ----

// Set by a counter that would have wrapped; the host reads it after each query.
static mut OVERFLOW: u32 = 0;

#[no_mangle]
pub extern "C" fn zs_overflowed() -> u32 {
    // Purpose: 1 if any counter in the last queries overflowed (the host turns this into an error)
    unsafe { OVERFLOW }
}

#[inline(always)]
fn bump(count: u32) -> u32 {
    // Purpose: add one to a u32 counter, checked unless built without the `checked` feature
    #[cfg(feature = "checked")]
    {
        match count.checked_add(1) {
            Some(next) => next,
            None => {
                unsafe { OVERFLOW = 1 };
                count
            }
        }
    }
    #[cfg(not(feature = "checked"))]
    {
        count.wrapping_add(1)
    }
}

// ---- hash table: open addressing, u64 key -> u32 count ----

struct Counts {
    keys: Vec<u64>,
    vals: Vec<u32>,
    used: Vec<bool>,
    mask: usize,
    len: usize,
}

#[inline(always)]
fn hash(key: u64) -> usize {
    // Purpose: Fibonacci hashing: multiply, keep the high bits
    (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32) as usize
}

impl Counts {
    fn with_capacity(rows_hint: usize) -> Counts {
        // Purpose: a table sized for about `rows_hint` distinct keys at load factor 0.5 or less
        let mut cap = 1024;
        while cap < rows_hint * 2 {
            cap <<= 1;
        }
        Counts { keys: vec![0; cap], vals: vec![0; cap], used: vec![false; cap], mask: cap - 1, len: 0 }
    }

    #[inline(always)]
    fn add(&mut self, key: u64) -> bool {
        // Purpose: count one more row for `key`; true when the key is new
        let mut i = hash(key) & self.mask;
        loop {
            if !self.used[i] {
                self.used[i] = true;
                self.keys[i] = key;
                self.vals[i] = bump(0);
                self.len += 1;
                if self.len * 2 > self.mask + 1 {
                    self.grow();
                }
                return true;
            }
            if self.keys[i] == key {
                self.vals[i] = bump(self.vals[i]);
                return false;
            }
            i = (i + 1) & self.mask;
        }
    }

    fn grow(&mut self) {
        // Purpose: double the table and re-insert every entry
        let old_keys = std::mem::take(&mut self.keys);
        let old_vals = std::mem::take(&mut self.vals);
        let old_used = std::mem::take(&mut self.used);
        let cap = (self.mask + 1) * 2;
        self.keys = vec![0; cap];
        self.vals = vec![0; cap];
        self.used = vec![false; cap];
        self.mask = cap - 1;
        for j in 0..old_keys.len() {
            if old_used[j] {
                let mut i = hash(old_keys[j]) & self.mask;
                while self.used[i] {
                    i = (i + 1) & self.mask;
                }
                self.used[i] = true;
                self.keys[i] = old_keys[j];
                self.vals[i] = old_vals[j];
            }
        }
    }

    fn entries(&self) -> impl Iterator<Item = (u64, u32)> + '_ {
        // Purpose: every (key, count) pair, in table order
        (0..self.keys.len()).filter(move |&i| self.used[i]).map(move |i| (self.keys[i], self.vals[i]))
    }
}

// ---- Q1: routes per network (group by origin_as and as_name) ----

#[no_mangle]
pub extern "C" fn zs_q1(
    n: usize,
    origin_as: *const u32,
    name_code: *const u32,
    out_as: *mut u32,
    out_name: *mut u32,
    out_count: *mut u32,
) -> usize {
    // Purpose: count rows per (origin_as, name code); writes one entry per group, returns the group count
    let (origin_as, name_code) = unsafe { (slice::from_raw_parts(origin_as, n), slice::from_raw_parts(name_code, n)) };
    let mut table = Counts::with_capacity(1 << 16);
    for i in 0..n {
        table.add(((origin_as[i] as u64) << 32) | name_code[i] as u64);
    }
    let mut written = 0;
    for (key, count) in table.entries() {
        unsafe {
            *out_as.add(written) = (key >> 32) as u32;
            *out_name.add(written) = key as u32;
            *out_count.add(written) = count;
        }
        written += 1;
    }
    written
}

// ---- Q3: routes and distinct networks per region (rir code is one byte) ----

#[no_mangle]
pub extern "C" fn zs_q3(n: usize, rir_code: *const u8, origin_as: *const u32, out_routes: *mut u32, out_networks: *mut u32) {
    // Purpose: per region code 0..=255: row count and distinct origin_as count; the host passes two 256-entry buffers
    let (rir_code, origin_as) = unsafe { (slice::from_raw_parts(rir_code, n), slice::from_raw_parts(origin_as, n)) };
    let routes = unsafe { slice::from_raw_parts_mut(out_routes, 256) };
    let networks = unsafe { slice::from_raw_parts_mut(out_networks, 256) };
    routes.fill(0);
    networks.fill(0);
    let mut seen = Counts::with_capacity(1 << 16);
    for i in 0..n {
        let r = rir_code[i] as usize;
        routes[r] = bump(routes[r]);
        if seen.add(((r as u64) << 32) | origin_as[i] as u64) {
            networks[r] = bump(networks[r]);
        }
    }
}

// ---- Q4: top 20 networks by route count (group, sort, limit) ----

#[no_mangle]
pub extern "C" fn zs_q4(n: usize, origin_as: *const u32, limit: usize, out_as: *mut u32, out_count: *mut u32) -> usize {
    // Purpose: the `limit` origin_as values with the most rows, count descending then origin_as ascending
    let origin_as = unsafe { slice::from_raw_parts(origin_as, n) };
    let mut table = Counts::with_capacity(1 << 16);
    for &a in origin_as {
        table.add(a as u64);
    }
    let mut all: Vec<(u32, u32)> = table.entries().map(|(k, c)| (c, k as u32)).collect();
    let order = |a: &(u32, u32), b: &(u32, u32)| b.0.cmp(&a.0).then(a.1.cmp(&b.1));
    let take = limit.min(all.len());
    if take < all.len() {
        all.select_nth_unstable_by(take, order);
    }
    all.truncate(take);
    all.sort_unstable_by(order);
    for (j, (count, a)) in all.iter().enumerate() {
        unsafe {
            *out_as.add(j) = *a;
            *out_count.add(j) = *count;
        }
    }
    take
}

// ---- Q7: full sort of every route by prefix_len, then prefix_addr ----

#[no_mangle]
pub extern "C" fn zs_q7(n: usize, prefix_len: *const u8, prefix_addr: *const u32, out_len: *mut u8, out_addr: *mut u32, radix: u32) {
    // Purpose: sort the rows by (prefix_len, prefix_addr) and write both columns in sorted order
    let (lens, addrs) = unsafe { (slice::from_raw_parts(prefix_len, n), slice::from_raw_parts(prefix_addr, n)) };
    let mut keys: Vec<u64> = (0..n).map(|i| ((lens[i] as u64) << 32) | addrs[i] as u64).collect();
    if radix == 1 {
        radix_sort_40(&mut keys);
    } else {
        keys.sort_unstable();
    }
    for (i, key) in keys.iter().enumerate() {
        unsafe {
            *out_len.add(i) = (key >> 32) as u8;
            *out_addr.add(i) = *key as u32;
        }
    }
}

fn radix_sort_40(keys: &mut Vec<u64>) {
    // Purpose: LSD radix sort on the low 40 bits (a length byte and a 32-bit address): four 10-bit passes
    let mut other = vec![0u64; keys.len()];
    for pass in 0..4 {
        let shift = pass * 10;
        let mut counts = [0usize; 1024];
        for &k in keys.iter() {
            counts[((k >> shift) & 1023) as usize] += 1;
        }
        if counts.iter().any(|&c| c == keys.len()) {
            continue; // every key has the same digit: nothing to move
        }
        let mut sum = 0;
        for c in counts.iter_mut() {
            let here = *c;
            *c = sum;
            sum += here;
        }
        for &k in keys.iter() {
            let d = ((k >> shift) & 1023) as usize;
            other[counts[d]] = k;
            counts[d] += 1;
        }
        std::mem::swap(keys, &mut other);
    }
}

// ---- the dashboard: one pass for the five controls, then one pass per chart ----
//
// zs_mask records, for every row, which controls it FAILS (one bit each). A chart
// then keeps the rows whose failed bits, minus the chart's own control, are none:
// `mask & keep == 0`. All four charts share the one mask, so a control is evaluated
// once per interaction instead of once per chart (the T-220 idea).

pub const FAIL_PREFIX: u8 = 1;
pub const FAIL_PATH: u8 = 2;
pub const FAIL_ADDR: u8 = 4;
pub const FAIL_REGION: u8 = 8;
pub const FAIL_NAME: u8 = 16;

#[no_mangle]
pub extern "C" fn zs_mask(
    n: usize,
    prefix_len: *const u8,
    path_len: *const u8,
    prefix_addr: *const u32,
    rir_code: *const u8,
    name_code: *const u32,
    bounds: *const u32,
    rir_ok: *const u8,
    name_ok: *const u8,
    name_ok_len: usize,
    out: *mut u8,
) {
    // Purpose: per row, a bit for each control the row fails. bounds = prefix lo, hi, path lo, hi, address lo, hi.
    // rir_ok has one flag per region code (256), name_ok one per name code; the host makes both from its controls.
    let (len, path, addr, rir, name, b, rir_ok, name_ok, out) = unsafe {
        (
            slice::from_raw_parts(prefix_len, n),
            slice::from_raw_parts(path_len, n),
            slice::from_raw_parts(prefix_addr, n),
            slice::from_raw_parts(rir_code, n),
            slice::from_raw_parts(name_code, n),
            slice::from_raw_parts(bounds, 6),
            slice::from_raw_parts(rir_ok, 256),
            slice::from_raw_parts(name_ok, name_ok_len),
            slice::from_raw_parts_mut(out, n),
        )
    };
    let (plo, phi, qlo, qhi, alo, ahi) = (b[0], b[1], b[2], b[3], b[4], b[5]);
    for i in 0..n {
        let l = len[i] as u32;
        let q = path[i] as u32;
        let a = addr[i];
        let mut m = ((l < plo || l > phi) as u8) * FAIL_PREFIX;
        m |= ((q < qlo || q > qhi) as u8) * FAIL_PATH;
        m |= ((a < alo || a > ahi) as u8) * FAIL_ADDR;
        m |= ((rir_ok[rir[i] as usize] == 0) as u8) * FAIL_REGION;
        m |= ((name_ok[name[i] as usize] == 0) as u8) * FAIL_NAME;
        out[i] = m;
    }
}

#[no_mangle]
pub extern "C" fn zs_c_networks(
    n: usize,
    mask: *const u8,
    keep: u8,
    origin_as: *const u32,
    name_code: *const u32,
    out_as: *mut u32,
    out_name: *mut u32,
    out_count: *mut u32,
) -> usize {
    // Purpose: the dashboard's per-network chart: routes per (origin_as, name) among the rows that pass the mask
    let (mask, origin_as, name_code) = unsafe { (slice::from_raw_parts(mask, n), slice::from_raw_parts(origin_as, n), slice::from_raw_parts(name_code, n)) };
    let mut table = Counts::with_capacity(1 << 16);
    for i in 0..n {
        if mask[i] & keep == 0 {
            table.add(((origin_as[i] as u64) << 32) | name_code[i] as u64);
        }
    }
    let mut written = 0;
    for (key, count) in table.entries() {
        unsafe {
            *out_as.add(written) = (key >> 32) as u32;
            *out_name.add(written) = key as u32;
            *out_count.add(written) = count;
        }
        written += 1;
    }
    written
}

#[no_mangle]
pub extern "C" fn zs_c_hist(n: usize, mask: *const u8, keep: u8, column: *const u8, out: *mut u32) {
    // Purpose: a histogram of a one-byte column (prefix length or path length) over the rows that pass the mask; 256 counters
    let (mask, column, out) = unsafe { (slice::from_raw_parts(mask, n), slice::from_raw_parts(column, n), slice::from_raw_parts_mut(out, 256)) };
    out.fill(0);
    for i in 0..n {
        if mask[i] & keep == 0 {
            let v = column[i] as usize;
            out[v] = bump(out[v]);
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_c_regions(n: usize, mask: *const u8, keep: u8, rir_code: *const u8, origin_as: *const u32, out_routes: *mut u32, out_networks: *mut u32) {
    // Purpose: routes and distinct networks per region code among the rows that pass the mask
    let (mask, rir_code, origin_as) = unsafe { (slice::from_raw_parts(mask, n), slice::from_raw_parts(rir_code, n), slice::from_raw_parts(origin_as, n)) };
    let routes = unsafe { slice::from_raw_parts_mut(out_routes, 256) };
    let networks = unsafe { slice::from_raw_parts_mut(out_networks, 256) };
    routes.fill(0);
    networks.fill(0);
    let mut seen = Counts::with_capacity(1 << 16);
    for i in 0..n {
        if mask[i] & keep != 0 {
            continue;
        }
        let r = rir_code[i] as usize;
        routes[r] = bump(routes[r]);
        if seen.add(((r as u64) << 32) | origin_as[i] as u64) {
            networks[r] = bump(networks[r]);
        }
    }
}

// ---- tests: every kernel against a naive version ----

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn data(n: usize) -> (Vec<u32>, Vec<u32>, Vec<u8>, Vec<u8>, Vec<u32>) {
        // Purpose: pseudo-random columns with the real table's shape: few regions, many networks, skewed
        let mut s: u64 = 0x1234_5678_9ABC_DEF0;
        let mut next = move || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        let (mut asn, mut name, mut len, mut rir, mut addr) = (vec![], vec![], vec![], vec![], vec![]);
        for _ in 0..n {
            let a = (next() % 5000) as u32 * (1 + (next() % 3) as u32);
            asn.push(a);
            name.push(if a % 7 == 0 { 0 } else { a / 3 + 1 });
            len.push(8 + (next() % 17) as u8);
            rir.push((next() % 6) as u8);
            addr.push(next() as u32);
        }
        (asn, name, len, rir, addr)
    }

    #[test]
    fn q1_matches_naive() {
        let (asn, name, ..) = data(50_000);
        let mut expect: BTreeMap<(u32, u32), u32> = BTreeMap::new();
        for i in 0..asn.len() {
            *expect.entry((asn[i], name[i])).or_default() += 1;
        }
        let (mut oa, mut on, mut oc) = (vec![0u32; asn.len()], vec![0u32; asn.len()], vec![0u32; asn.len()]);
        let g = zs_q1(asn.len(), asn.as_ptr(), name.as_ptr(), oa.as_mut_ptr(), on.as_mut_ptr(), oc.as_mut_ptr());
        let got: BTreeMap<(u32, u32), u32> = (0..g).map(|j| ((oa[j], on[j]), oc[j])).collect();
        assert_eq!(got, expect);
    }

    #[test]
    fn q3_matches_naive() {
        let (asn, _, _, rir, _) = data(50_000);
        let mut routes = [0u32; 256];
        let mut sets: Vec<BTreeSet<u32>> = vec![BTreeSet::new(); 256];
        for i in 0..asn.len() {
            routes[rir[i] as usize] += 1;
            sets[rir[i] as usize].insert(asn[i]);
        }
        let (mut r, mut nw) = ([0u32; 256], [0u32; 256]);
        zs_q3(asn.len(), rir.as_ptr(), asn.as_ptr(), r.as_mut_ptr(), nw.as_mut_ptr());
        assert_eq!(r, routes);
        for k in 0..256 {
            assert_eq!(nw[k] as usize, sets[k].len());
        }
    }

    #[test]
    fn q4_matches_naive() {
        let (asn, ..) = data(50_000);
        let mut counts: BTreeMap<u32, u32> = BTreeMap::new();
        for &a in &asn {
            *counts.entry(a).or_default() += 1;
        }
        let mut expect: Vec<(u32, u32)> = counts.into_iter().map(|(a, c)| (c, a)).collect();
        expect.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        expect.truncate(20);
        let (mut oa, mut oc) = (vec![0u32; 20], vec![0u32; 20]);
        let took = zs_q4(asn.len(), asn.as_ptr(), 20, oa.as_mut_ptr(), oc.as_mut_ptr());
        assert_eq!(took, 20);
        let got: Vec<(u32, u32)> = (0..20).map(|j| (oc[j], oa[j])).collect();
        assert_eq!(got, expect);
    }

    #[test]
    fn q7_matches_naive_for_both_sorts() {
        let (_, _, len, _, addr) = data(50_000);
        let mut expect: Vec<(u8, u32)> = len.iter().cloned().zip(addr.iter().cloned()).collect();
        expect.sort();
        for radix in 0..2 {
            let (mut ol, mut oa) = (vec![0u8; len.len()], vec![0u32; len.len()]);
            zs_q7(len.len(), len.as_ptr(), addr.as_ptr(), ol.as_mut_ptr(), oa.as_mut_ptr(), radix);
            let got: Vec<(u8, u32)> = ol.into_iter().zip(oa).collect();
            assert_eq!(got, expect, "radix={radix}");
        }
    }


    #[test]
    fn dashboard_kernels_match_naive_for_every_own_control() {
        let (asn, name, len, rir, addr) = data(40_000);
        let path: Vec<u8> = len.iter().map(|l| l % 9).collect();
        let bounds: [u32; 6] = [10, 20, 2, 6, 1 << 30, 3 << 30];
        let mut rir_ok = [0u8; 256];
        rir_ok[1] = 1;
        rir_ok[3] = 1;
        let name_ok: Vec<u8> = (0..=6000).map(|c| (c % 3 != 0) as u8).collect();
        let n = asn.len();
        let mut mask = vec![0u8; n];
        zs_mask(n, len.as_ptr(), path.as_ptr(), addr.as_ptr(), rir.as_ptr(), name.as_ptr(), bounds.as_ptr(), rir_ok.as_ptr(), name_ok.as_ptr(), name_ok.len(), mask.as_mut_ptr());
        let fails = |i: usize| -> u8 {
            let mut m = 0;
            if (len[i] as u32) < bounds[0] || (len[i] as u32) > bounds[1] { m |= FAIL_PREFIX }
            if (path[i] as u32) < bounds[2] || (path[i] as u32) > bounds[3] { m |= FAIL_PATH }
            if addr[i] < bounds[4] || addr[i] > bounds[5] { m |= FAIL_ADDR }
            if rir_ok[rir[i] as usize] == 0 { m |= FAIL_REGION }
            if name_ok[name[i] as usize] == 0 { m |= FAIL_NAME }
            m
        };
        for i in 0..n {
            assert_eq!(mask[i], fails(i), "row {i}");
        }
        for own in [0u8, FAIL_PREFIX, FAIL_PATH, FAIL_REGION] {
            let keep = !own;
            let pass: Vec<usize> = (0..n).filter(|&i| fails(i) & keep == 0).collect();
            // networks
            let mut expect: BTreeMap<(u32, u32), u32> = BTreeMap::new();
            for &i in &pass {
                *expect.entry((asn[i], name[i])).or_default() += 1;
            }
            let (mut oa, mut on, mut oc) = (vec![0u32; n], vec![0u32; n], vec![0u32; n]);
            let g = zs_c_networks(n, mask.as_ptr(), keep, asn.as_ptr(), name.as_ptr(), oa.as_mut_ptr(), on.as_mut_ptr(), oc.as_mut_ptr());
            let got: BTreeMap<(u32, u32), u32> = (0..g).map(|j| ((oa[j], on[j]), oc[j])).collect();
            assert_eq!(got, expect, "networks, own={own}");
            // histogram of prefix length
            let mut h = [0u32; 256];
            zs_c_hist(n, mask.as_ptr(), keep, len.as_ptr(), h.as_mut_ptr());
            let mut eh = [0u32; 256];
            for &i in &pass {
                eh[len[i] as usize] += 1;
            }
            assert_eq!(h, eh, "hist, own={own}");
            // regions
            let (mut r, mut nw) = ([0u32; 256], [0u32; 256]);
            zs_c_regions(n, mask.as_ptr(), keep, rir.as_ptr(), asn.as_ptr(), r.as_mut_ptr(), nw.as_mut_ptr());
            let mut er = [0u32; 256];
            let mut sets: Vec<BTreeSet<u32>> = vec![BTreeSet::new(); 256];
            for &i in &pass {
                er[rir[i] as usize] += 1;
                sets[rir[i] as usize].insert(asn[i]);
            }
            assert_eq!(r, er, "regions routes, own={own}");
            for k in 0..256 {
                assert_eq!(nw[k] as usize, sets[k].len(), "regions networks {k}, own={own}");
            }
        }
    }

    #[test]
    fn counter_overflow_is_reported() {
        unsafe { OVERFLOW = 0 };
        assert_eq!(bump(u32::MAX), u32::MAX);
        #[cfg(feature = "checked")]
        assert_eq!(zs_overflowed(), 1);
        unsafe { OVERFLOW = 0 };
    }
}
