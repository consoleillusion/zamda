// Tests for the table store (T-403): segments, validity, dictionary codes,
// the retain window, snapshots and the C interface.

use zamda_engine::store::{Snapshot, StoreError, Table};
use zamda_engine::types::Type;

fn put<T: Copy>(table: &mut Table, col: usize, data: &[T]) {
    // Purpose: write a column's values into the staged segment, as the host does
    let ptr = table.values_ptr(col).unwrap() as *mut T;
    unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len()) };
}

fn put_valid(table: &mut Table, col: usize, valid: &[u8]) {
    // Purpose: write a column's validity bytes into the staged segment
    let ptr = table.valid_ptr(col).unwrap();
    unsafe { std::ptr::copy_nonoverlapping(valid.as_ptr(), ptr, valid.len()) };
}

fn ints(table: &mut Table, values: &[i32]) {
    // Purpose: append one segment to a single int32 column table
    table.begin(values.len() as u32).unwrap();
    put(table, 0, values);
    table.commit().unwrap();
}

fn read(table: &Table) -> Vec<i32> {
    // Purpose: every int32 value the table holds, in order
    table.segments().iter().flat_map(|v| v.values::<i32>(0).to_vec()).collect()
}

#[test]
fn a_table_needs_a_column() {
    // Purpose: no columns is refused
    assert_eq!(Table::new(&[], None).err(), Some(StoreError::NoColumns));
}

#[test]
fn segments_read_back_in_place_with_their_types() {
    // Purpose: values of several widths come back exactly, and validity is kept only where something is null
    let mut t = Table::new(&[Type::Int32, Type::Float64, Type::Uint8, Type::Int64], None).unwrap();
    t.begin(3).unwrap();
    put(&mut t, 0, &[1i32, -2, 3]);
    put(&mut t, 1, &[0.5f64, f64::NAN, -0.0]);
    put(&mut t, 2, &[7u8, 8, 9]);
    put(&mut t, 3, &[i64::MIN, 0, i64::MAX]);
    put_valid(&mut t, 0, &[1, 0, 1]);
    put_valid(&mut t, 2, &[1, 1, 1]);
    t.commit().unwrap();
    let v = &t.segments()[0];
    assert_eq!(t.rows(), 3);
    assert_eq!(v.values::<i32>(0), &[1, -2, 3]);
    assert_eq!(v.valid(0), Some(&[1u8, 0, 1][..]));
    assert!(v.values::<f64>(1)[1].is_nan());
    assert!(v.values::<f64>(1)[2].is_sign_negative());
    assert_eq!(v.valid(1), None);
    assert_eq!(v.valid(2), None, "an all-valid column drops its validity bytes");
    assert_eq!(v.values::<i64>(3), &[i64::MIN, 0, i64::MAX]);
    assert!(v.has_nulls(0) && !v.has_nulls(2));
}

#[test]
fn every_buffer_is_aligned_for_its_type() {
    // Purpose: 8-byte values can be read in place, also after the retain window trimmed the front
    let mut t = Table::new(&[Type::Uint8, Type::Float64], Some(5)).unwrap();
    t.begin(7).unwrap();
    put(&mut t, 0, &[1u8, 2, 3, 4, 5, 6, 7]);
    put(&mut t, 1, &[1f64, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]);
    t.commit().unwrap();
    let v = &t.segments()[0];
    assert_eq!(v.values::<f64>(1), &[3.0, 4.0, 5.0, 6.0, 7.0]);
    assert_eq!(v.values::<f64>(1).as_ptr() as usize % 8, 0);
}

#[test]
fn a_bad_segment_is_rejected_whole() {
    // Purpose: C-LIVE: a failed append leaves the table unchanged, whatever the reason
    let mut t = Table::new(&[Type::Int32, Type::Dictionary], None).unwrap();
    t.begin(2).unwrap();
    put(&mut t, 0, &[1i32, 2]);
    put(&mut t, 1, &[0i32, 1]);
    t.set_dict_len(1, 2).unwrap();
    t.commit().unwrap();

    // a code past the dictionary
    t.begin(2).unwrap();
    put(&mut t, 0, &[3i32, 4]);
    put(&mut t, 1, &[0i32, 2]);
    t.set_dict_len(1, 2).unwrap();
    assert_eq!(t.commit(), Err(StoreError::CodeOutOfRange));
    // a negative code
    t.begin(1).unwrap();
    put(&mut t, 0, &[3i32]);
    put(&mut t, 1, &[-1i32]);
    t.set_dict_len(1, 2).unwrap();
    assert_eq!(t.commit(), Err(StoreError::CodeOutOfRange));
    // a code column without its dictionary size
    t.begin(1).unwrap();
    put(&mut t, 0, &[3i32]);
    put(&mut t, 1, &[0i32]);
    assert_eq!(t.commit(), Err(StoreError::MissingDictLen));
    // a column the host never wrote
    t.begin(1).unwrap();
    put(&mut t, 0, &[3i32]);
    assert_eq!(t.commit(), Err(StoreError::MissingColumn));
    // a validity byte that is not 0 or 1
    t.begin(1).unwrap();
    put(&mut t, 0, &[3i32]);
    put(&mut t, 1, &[0i32]);
    t.set_dict_len(1, 2).unwrap();
    put_valid(&mut t, 0, &[2]);
    assert_eq!(t.commit(), Err(StoreError::BadValidity));
    // committing with nothing staged
    assert_eq!(t.commit(), Err(StoreError::NotStaged));

    assert_eq!(t.rows(), 2);
    assert_eq!(t.segments().len(), 1);
    assert_eq!(t.segments()[0].values::<i32>(0), &[1, 2]);
}

#[test]
fn null_rows_may_hold_any_code() {
    // Purpose: the code under a null is ignored, as the JS loader ignores the value under a null
    let mut t = Table::new(&[Type::Dictionary], None).unwrap();
    t.begin(3).unwrap();
    put(&mut t, 0, &[0i32, 999, -5]);
    put_valid(&mut t, 0, &[1, 0, 0]);
    t.set_dict_len(0, 1).unwrap();
    t.commit().unwrap();
    assert_eq!(t.rows(), 3);
}

#[test]
fn utf8_columns_are_code_columns_too() {
    // Purpose: a utf8 column is stored as codes and checked like a dictionary column
    let mut t = Table::new(&[Type::Utf8], None).unwrap();
    t.begin(1).unwrap();
    put(&mut t, 0, &[4i32]);
    t.set_dict_len(0, 4).unwrap();
    assert_eq!(t.commit(), Err(StoreError::CodeOutOfRange));
}

#[test]
fn bad_columns_and_missing_staging_are_reported() {
    // Purpose: calls out of order or out of range return errors instead of panicking
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    assert_eq!(t.values_ptr(0).err(), Some(StoreError::NotStaged));
    t.begin(1).unwrap();
    assert_eq!(t.values_ptr(1).err(), Some(StoreError::BadColumn));
    assert_eq!(t.valid_ptr(9).err(), Some(StoreError::BadColumn));
    assert_eq!(t.set_dict_len(2, 1).err(), Some(StoreError::BadColumn));
}

#[test]
fn an_empty_segment_adds_nothing() {
    // Purpose: zero rows is a no-op, like the JS backend
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    t.begin(0).unwrap();
    put::<i32>(&mut t, 0, &[]);
    t.commit().unwrap();
    assert_eq!((t.rows(), t.segments().len()), (0, 0));
}

#[test]
fn begin_discards_an_unfinished_segment() {
    // Purpose: starting again, or aborting, drops what was staged
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    t.begin(1).unwrap();
    put(&mut t, 0, &[1i32]);
    t.begin(2).unwrap();
    put(&mut t, 0, &[8i32, 9]);
    t.commit().unwrap();
    t.begin(1).unwrap();
    t.abort();
    assert_eq!(t.commit(), Err(StoreError::NotStaged));
    assert_eq!(read(&t), vec![8, 9]);
}

#[test]
fn the_retain_window_keeps_exactly_the_latest_rows() {
    // Purpose: C-LIVE: with retain N the table holds the most recent N rows, across segment boundaries
    let mut t = Table::new(&[Type::Int32], Some(5)).unwrap();
    ints(&mut t, &[1, 2, 3]);
    assert_eq!((t.rows(), t.dropped()), (3, 0));
    ints(&mut t, &[4, 5]);
    assert_eq!(read(&t), vec![1, 2, 3, 4, 5]);
    ints(&mut t, &[6]);
    assert_eq!(read(&t), vec![2, 3, 4, 5, 6]);
    assert_eq!((t.rows(), t.dropped(), t.segments().len()), (5, 1, 3));
    ints(&mut t, &[7, 8, 9]);
    assert_eq!(read(&t), vec![5, 6, 7, 8, 9]);
    assert_eq!((t.rows(), t.dropped(), t.segments().len()), (5, 4, 3));
    // one append bigger than the window
    ints(&mut t, &[10, 11, 12, 13, 14, 15, 16, 17]);
    assert_eq!(read(&t), vec![13, 14, 15, 16, 17]);
    assert_eq!((t.rows(), t.dropped(), t.segments().len()), (5, 12, 1));
    // exactly the window
    ints(&mut t, &[20, 21, 22, 23, 24]);
    assert_eq!(read(&t), vec![20, 21, 22, 23, 24]);
}

#[test]
fn a_trimmed_view_keeps_validity_and_codes_aligned() {
    // Purpose: after a front trim, validity bytes and values still line up row for row
    let mut t = Table::new(&[Type::Int32], Some(3)).unwrap();
    t.begin(5).unwrap();
    put(&mut t, 0, &[10i32, 20, 30, 40, 50]);
    put_valid(&mut t, 0, &[1, 0, 1, 0, 1]);
    t.commit().unwrap();
    let v = &t.segments()[0];
    assert_eq!(v.values::<i32>(0), &[30, 40, 50]);
    assert_eq!(v.valid(0), Some(&[1u8, 0, 1][..]));
}

#[test]
fn a_snapshot_keeps_seeing_the_table_it_was_taken_from() {
    // Purpose: C-LIVE: appends and dropped rows after the snapshot do not change what it reads
    let mut t = Table::new(&[Type::Int32], Some(4)).unwrap();
    ints(&mut t, &[1, 2, 3, 4]);
    let snap = t.snapshot();
    ints(&mut t, &[5, 6, 7, 8, 9, 10]);
    assert_eq!(read(&t), vec![7, 8, 9, 10]);
    let seen: Vec<i32> = snap.segments.iter().flat_map(|v| v.values::<i32>(0).to_vec()).collect();
    assert_eq!(seen, vec![1, 2, 3, 4]);
    assert_eq!(snap.rows, 4);
}

#[test]
fn a_table_built_by_appends_equals_one_built_at_once() {
    // Purpose: C-LIVE: the same rows give the same values however they were split into appends
    let all: Vec<i32> = (0..100).map(|i| i * 7 - 300).collect();
    let mut once = Table::new(&[Type::Int32], None).unwrap();
    ints(&mut once, &all);
    let mut parts = Table::new(&[Type::Int32], None).unwrap();
    for chunk in all.chunks(13) {
        ints(&mut parts, chunk);
    }
    assert_eq!(read(&once), read(&parts));
    assert_eq!(once.rows(), parts.rows());
}

#[test]
fn the_c_interface_round_trips() {
    // Purpose: the handle-based functions the host calls: create, stage, commit, snapshot, read, free, and errors
    use zamda_engine::store_abi::*;
    let types = [3u8, 12]; // int32, dictionary
    let t = zs_table_new(types.as_ptr(), 2, 3);
    assert_ne!(t, 0);
    assert_eq!(zs_seg_begin(t, 2), 0);
    let a = zs_seg_values(t, 0) as *mut i32;
    let b = zs_seg_values(t, 1) as *mut i32;
    unsafe {
        *a = 5;
        *a.add(1) = 6;
        *b = 0;
        *b.add(1) = 1;
    }
    let valid = zs_seg_valid(t, 1);
    unsafe {
        *valid = 1;
        *valid.add(1) = 0;
    }
    assert_eq!(zs_seg_dict(t, 1, 1), 0);
    assert_eq!(zs_seg_commit(t), 0);
    assert_eq!(zs_table_rows(t), 2.0);

    let s = zs_snapshot(t);
    assert_ne!(s, 0);
    assert_eq!(zs_snapshot_rows(s), 2.0);
    assert_eq!(zs_snapshot_segments(s), 1);
    assert_eq!(zs_snapshot_segment_rows(s, 0), 2);
    assert_eq!(zs_snapshot_dict_len(s, 0, 1), 1);
    let read = zs_snapshot_values(s, 0, 0) as *const i32;
    assert_eq!(unsafe { *read.add(1) }, 6);
    assert!(!zs_snapshot_valid(s, 0, 1).is_null());
    assert!(zs_snapshot_valid(s, 0, 0).is_null());
    assert_eq!(zs_store_error(), 0);

    // a bad segment: the code 7 is not in a dictionary of one entry
    assert_eq!(zs_seg_begin(t, 1), 0);
    unsafe {
        *(zs_seg_values(t, 0) as *mut i32) = 1;
        *(zs_seg_values(t, 1) as *mut i32) = 7;
    }
    assert_eq!(zs_seg_dict(t, 1, 1), 0);
    assert_eq!(zs_seg_commit(t), StoreError::CodeOutOfRange as u32);
    assert_eq!(zs_store_error(), StoreError::CodeOutOfRange as u32);
    assert_eq!(zs_table_rows(t), 2.0);

    // the retain window drops rows, the snapshot still reads them
    assert_eq!(zs_seg_begin(t, 3), 0);
    for c in 0..2 {
        let p = zs_seg_values(t, c) as *mut i32;
        unsafe {
            for i in 0..3 {
                *p.add(i) = 0;
            }
        }
    }
    assert_eq!(zs_seg_dict(t, 1, 1), 0);
    assert_eq!(zs_seg_commit(t), 0);
    assert_eq!((zs_table_rows(t), zs_table_dropped(t)), (3.0, 2.0));
    assert_eq!(zs_snapshot_rows(s), 2.0);
    assert_eq!(unsafe { *(zs_snapshot_values(s, 0, 0) as *const i32) }, 5);

    // errors
    assert_eq!(zs_snapshot_segment_id(s, 9), -1.0);
    assert_eq!(zs_store_error(), StoreError::BadSegment as u32);
    assert!(zs_snapshot_values(s, 0, 9).is_null());
    assert_eq!(zs_store_error(), StoreError::BadColumn as u32);
    assert_eq!(zs_snapshot_free(s), 0);
    assert_eq!(zs_snapshot_free(s), StoreError::BadHandle as u32);
    assert_eq!(zs_table_free(t), 0);
    assert_eq!(zs_table_rows(t), -1.0);
    assert_eq!(zs_table_new([99u8].as_ptr(), 1, 0), 0);
    assert_eq!(zs_store_error(), StoreError::BadTypeId as u32);
    assert_eq!(zs_table_new(types.as_ptr(), 0, 0), 0);
    assert_eq!(zs_store_error(), StoreError::NoColumns as u32);
    assert_eq!(zs_type_width(4), 8);
    assert_eq!(zs_type_width(200), 0);
}

#[test]
fn many_tiny_appends_compact_into_shared_storage() {
    // Purpose: compaction changes the buffers, not the views: every id, row, value and snapshot stays as it was
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    let mut ids = Vec::new();
    let mut before: Option<Snapshot> = None;
    for i in 0..40i32 {
        t.begin(1).unwrap();
        put(&mut t, 0, &[i]);
        t.commit().unwrap();
        ids.push(t.segments().last().unwrap().id);
        if i == 7 {
            before = Some(t.snapshot());
        }
    }
    let before = before.unwrap();
    assert_eq!((t.rows(), t.segments().len()), (40, 40));
    assert_eq!(t.segments().iter().map(|v| v.id).collect::<Vec<_>>(), ids);
    assert_eq!(read(&t), (0..40).collect::<Vec<_>>());

    // Before the threshold each append owns its block; after it, a run of sixteen shares one.
    assert!(!before.segments[0].shares_storage_with(&before.segments[1]));
    let compacted = &t.segments()[0..16];
    assert!(compacted[1..].iter().all(|v| v.shares_storage_with(&compacted[0])));
    assert!(!t.segments()[16].shares_storage_with(&compacted[0]));
    let fresh = t.snapshot();
    assert!(fresh.segments[0].shares_storage_with(&fresh.segments[15]));

    // A run started before compaction keeps the old blocks and their exact views.
    assert!(!before.segments[0].shares_storage_with(&compacted[0]));
    assert_eq!(before.rows, 8);
    assert_eq!(before.segments.iter().map(|v| v.id).collect::<Vec<_>>(), ids[0..8]);
    let old: Vec<i32> = before.segments.iter().flat_map(|v| v.values::<i32>(0).to_vec()).collect();
    assert_eq!(old, (0..8).collect::<Vec<_>>());
}

#[test]
fn compaction_keeps_dictionary_codes_validity_and_sizes() {
    // Purpose: a merged block still answers with each view's own codes, dictionary size and presence of validity bytes
    let mut t = Table::new(&[Type::Int32, Type::Dictionary], None).unwrap();
    let mut expected: Vec<([i32; 2], u32, Option<Vec<u8>>)> = Vec::new();
    let mut before: Option<Snapshot> = None;
    for i in 0..24usize {
        let dict_len = (i % 3 + 1) as u32;
        let code = i as i32 % dict_len as i32;
        let null = i % 4 == 1;
        let codes = if null { [code, -7] } else { [code, code] };
        let valid = if null { Some(vec![1u8, 0]) } else { None };
        t.begin(2).unwrap();
        put(&mut t, 0, &[i as i32 * 2, i as i32 * 2 + 1]);
        put(&mut t, 1, &codes);
        if let Some(v) = &valid {
            put_valid(&mut t, 1, v);
        }
        t.set_dict_len(1, dict_len).unwrap();
        t.commit().unwrap();
        expected.push((codes, dict_len, valid));
        if i == 3 {
            before = Some(t.snapshot());
        }
    }
    let before = before.unwrap();
    for (i, v) in t.segments().iter().enumerate() {
        assert_eq!(v.values::<i32>(0), &[i as i32 * 2, i as i32 * 2 + 1]);
        assert_eq!(v.values::<i32>(1), &expected[i].0, "codes of segment {i}");
        assert_eq!(v.dict_len(1), expected[i].1, "dictionary of segment {i}");
        match &expected[i].2 {
            Some(bytes) => {
                assert_eq!(v.valid(1), Some(&bytes[..]), "validity of segment {i}");
                assert!(v.has_nulls(1));
            }
            None => {
                // Even though the merged block holds validity bytes for a
                // neighbour, a segment that had none still reports none.
                assert_eq!(v.valid(1), None, "validity of segment {i}");
                assert!(!v.has_nulls(1));
            }
        }
    }
    for (i, v) in before.segments.iter().enumerate() {
        assert_eq!(v.values::<i32>(1), &expected[i].0, "old codes of segment {i}");
        assert_eq!(v.dict_len(1), expected[i].1, "old dictionary of segment {i}");
        assert_eq!(v.valid(1), expected[i].2.as_ref().map(|b| &b[..]));
    }
}

#[test]
fn a_retain_window_trims_compacted_views_without_losing_rows() {
    // Purpose: C-LIVE with compaction: the newest N rows are exact, and a snapshot from before compaction is untouched
    let mut t = Table::new(&[Type::Int32], Some(20)).unwrap();
    let mut before: Option<Snapshot> = None;
    for i in 0..100i32 {
        t.begin(1).unwrap();
        put(&mut t, 0, &[i]);
        t.commit().unwrap();
        if i == 5 {
            before = Some(t.snapshot());
        }
    }
    let before = before.unwrap();
    assert_eq!(read(&t), (80..100).collect::<Vec<_>>());
    assert_eq!((t.rows(), t.dropped()), (20, 80));
    let ids: Vec<u64> = t.segments().iter().map(|v| v.id).collect();
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), ids.len(), "compaction must not repeat a segment id");
    assert!(t.segments().iter().any(|v| v.offset() > 0), "the oldest view is trimmed inside a merged block");
    let old: Vec<i32> = before.segments.iter().flat_map(|v| v.values::<i32>(0).to_vec()).collect();
    assert_eq!(old, (0..6).collect::<Vec<_>>());
    assert_eq!(before.rows, 6);
}

#[test]
fn compaction_does_not_repeat_on_the_next_append() {
    // Purpose: a new append starts a fresh block instead of copying the one just merged
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    for i in 0..16i32 {
        t.begin(1).unwrap();
        put(&mut t, 0, &[i]);
        t.commit().unwrap();
    }
    let first = &t.segments()[0];
    let at = first.values_ptr(0);
    assert!(first.shares_storage_with(&t.segments()[15]));
    t.begin(1).unwrap();
    put(&mut t, 0, &[16]);
    t.commit().unwrap();
    assert_eq!(t.segments()[0].values_ptr(0), at);
    assert!(t.segments()[0].shares_storage_with(&t.segments()[15]));
    assert!(!t.segments()[0].shares_storage_with(&t.segments()[16]));
    assert_eq!(read(&t), (0..17).collect::<Vec<_>>());
}

#[test]
fn widths_match_the_js_storage() {
    // Purpose: bytes per value for every type id, as the JS side stores them (docs/IR-BINARY.md numbering)
    use zamda_engine::store_abi::zs_type_width;
    // bool, int8, int16, int32, int64, uint8, uint16, uint32, uint64, float32, float64, utf8, dictionary, date32, timestamp
    let expected = [1, 1, 2, 4, 8, 1, 2, 4, 8, 4, 8, 4, 4, 4, 8];
    for (id, width) in expected.iter().enumerate() {
        assert_eq!(zs_type_width(id as u8), *width, "type id {id}");
    }
}

#[test]
fn commit_at_replaces_segments_in_place_and_snapshots_keep_the_old_ones() {
    // Purpose: keyed tables rewrite one segment; a snapshot taken before still reads the old rows
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    for block in [[0, 1], [2, 3], [4, 5]] {
        t.begin(2).unwrap();
        put(&mut t, 0, &block);
        t.commit().unwrap();
    }
    let before = t.snapshot();
    t.begin(3).unwrap();
    put(&mut t, 0, &[20, 30, 31]);
    t.commit_at(1, 1).unwrap();
    assert_eq!(read(&t), vec![0, 1, 20, 30, 31, 4, 5]);
    assert_eq!(t.rows(), 7);
    let old: Vec<i32> = before.segments.iter().flat_map(|v| v.values::<i32>(0).to_vec()).collect();
    assert_eq!(old, vec![0, 1, 2, 3, 4, 5]);
    // Insert without replacing, then remove, then an empty commit that only removes.
    t.begin(1).unwrap();
    put(&mut t, 0, &[9]);
    t.commit_at(0, 0).unwrap();
    assert_eq!(read(&t), vec![9, 0, 1, 20, 30, 31, 4, 5]);
    t.remove(1, 1).unwrap();
    assert_eq!(read(&t), vec![9, 20, 30, 31, 4, 5]);
    t.begin(0).unwrap();
    t.commit_at(2, 1).unwrap();
    assert_eq!(read(&t), vec![9, 20, 30, 31]);
    assert_eq!(t.rows(), 4);
}

#[test]
fn commit_at_and_remove_refuse_a_range_past_the_end() {
    // Purpose: a bad range is an error and leaves the table unchanged
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    t.begin(2).unwrap();
    put(&mut t, 0, &[1, 2]);
    t.commit().unwrap();
    t.begin(1).unwrap();
    put(&mut t, 0, &[7]);
    assert!(t.commit_at(1, 1).is_err());
    assert!(t.remove(0, 2).is_err());
    assert!(t.remove(usize::MAX, 2).is_err());
    assert_eq!(read(&t), vec![1, 2]);
}

#[test]
fn restore_undoes_edits_back_to_a_snapshot() {
    // Purpose: an edit that fails part way is undone by restoring the snapshot taken before it
    let mut t = Table::new(&[Type::Int32], None).unwrap();
    ints(&mut t, &[1, 2]);
    ints(&mut t, &[3]);
    let before = t.snapshot();
    t.remove(0, 1).unwrap();
    t.begin(1).unwrap();
    put(&mut t, 0, &[8]);
    t.commit_at(0, 1).unwrap();
    assert_eq!(read(&t), vec![8]);
    t.restore(&before).unwrap();
    assert_eq!(read(&t), vec![1, 2, 3]);
    assert_eq!(t.rows(), 3);
    let other = Table::new(&[Type::Float64], None).unwrap();
    let mut other = other;
    other.begin(1).unwrap();
    put(&mut other, 0, &[1.5f64]);
    other.commit().unwrap();
    assert!(t.restore(&other.snapshot()).is_err(), "a snapshot of another schema is refused");
}
