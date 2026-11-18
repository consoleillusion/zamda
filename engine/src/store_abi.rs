// The C interface to the table store, for the host (WASM exports, or a native
// library for tests). Tables and snapshots are handles: small numbers, 0 being
// "none". Functions that can fail return a status (0 = ok) or a null pointer or
// 0 handle, and `zs_store_error` then gives the error code (store.rs).
//
// Appending a segment is: zs_seg_begin, then for each column zs_seg_values (and
// zs_seg_valid if something is null, and zs_seg_dict for code columns), the
// host writes into the returned blocks, then zs_seg_commit. The segment is
// checked whole at commit; on any error the table is unchanged.

use std::cell::{Cell, RefCell};

use crate::store::{width, Snapshot, StoreError, Table};
use crate::types::Type;

struct Registry {
    tables: Vec<Option<Table>>,
    snapshots: Vec<Option<Snapshot>>,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = const { RefCell::new(Registry { tables: Vec::new(), snapshots: Vec::new() }) };
    static LAST_ERROR: Cell<u32> = const { Cell::new(0) };
}

fn fail(e: StoreError) -> u32 {
    // Purpose: remember an error code for zs_store_error and return it
    LAST_ERROR.with(|c| c.set(e as u32));
    e as u32
}

fn with_table<R>(handle: u32, f: impl FnOnce(&mut Table) -> Result<R, StoreError>) -> Result<R, StoreError> {
    // Purpose: run `f` on the table behind a handle
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let slot = (handle as usize).checked_sub(1).and_then(|i| r.tables.get_mut(i)).and_then(|t| t.as_mut());
        f(slot.ok_or(StoreError::BadHandle)?)
    })
}

pub(crate) fn with_snapshot<R>(handle: u32, f: impl FnOnce(&Snapshot) -> Result<R, StoreError>) -> Result<R, StoreError> {
    // Purpose: run `f` on the snapshot behind a handle
    REGISTRY.with(|r| {
        let r = r.borrow();
        let slot = (handle as usize).checked_sub(1).and_then(|i| r.snapshots.get(i)).and_then(|t| t.as_ref());
        f(slot.ok_or(StoreError::BadHandle)?)
    })
}

fn place<T>(slots: &mut Vec<Option<T>>, value: T) -> u32 {
    // Purpose: store a value in the first free slot and return its handle (index + 1)
    if let Some(i) = slots.iter().position(|s| s.is_none()) {
        slots[i] = Some(value);
        return i as u32 + 1;
    }
    slots.push(Some(value));
    slots.len() as u32
}

fn status(r: Result<(), StoreError>) -> u32 {
    // Purpose: 0 for ok, otherwise the error code
    match r {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

fn pointer(r: Result<*mut u8, StoreError>) -> *mut u8 {
    // Purpose: the pointer, or null with the error remembered
    match r {
        Ok(p) => p,
        Err(e) => {
            fail(e);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_store_error() -> u32 {
    // Purpose: the error code of the last failed store call on this thread
    LAST_ERROR.with(|c| c.get())
}

#[no_mangle]
pub extern "C" fn zs_table_new(types: *const u8, columns: u32, retain: u32) -> u32 {
    // Purpose: create a table from column type ids (binary IR numbering); retain 0 means keep every row; returns a handle, 0 on error
    let ids = unsafe { std::slice::from_raw_parts(types, columns as usize) };
    let mut list = Vec::with_capacity(ids.len());
    for &id in ids {
        match Type::from_id(id) {
            Some(t) => list.push(t),
            None => return {
                fail(StoreError::BadTypeId);
                0
            },
        }
    }
    match Table::new(&list, if retain == 0 { None } else { Some(retain) }) {
        Ok(t) => REGISTRY.with(|r| place(&mut r.borrow_mut().tables, t)),
        Err(e) => {
            fail(e);
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_table_free(table: u32) -> u32 {
    // Purpose: delete a table; snapshots taken from it stay valid
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        match (table as usize).checked_sub(1).and_then(|i| r.tables.get_mut(i)) {
            Some(slot) if slot.is_some() => {
                *slot = None;
                0
            }
            _ => fail(StoreError::BadHandle),
        }
    })
}

#[no_mangle]
pub extern "C" fn zs_table_rows(table: u32) -> f64 {
    // Purpose: rows in the table now (-1 for a bad handle)
    with_table(table, |t| Ok(t.rows() as f64)).unwrap_or_else(|e| {
        fail(e);
        -1.0
    })
}

#[no_mangle]
pub extern "C" fn zs_table_dropped(table: u32) -> f64 {
    // Purpose: rows removed so far by the retain window (-1 for a bad handle)
    with_table(table, |t| Ok(t.dropped() as f64)).unwrap_or_else(|e| {
        fail(e);
        -1.0
    })
}

#[no_mangle]
pub extern "C" fn zs_table_segments(table: u32) -> u32 {
    // Purpose: number of segments the table holds now (0 for a bad handle)
    with_table(table, |t| Ok(t.segments().len() as u32)).unwrap_or_else(|e| {
        fail(e);
        0
    })
}

#[no_mangle]
pub extern "C" fn zs_table_segment_id(table: u32, index: u32) -> f64 {
    // Purpose: the id of the table's segment at `index`, oldest first (-1 on error)
    with_table(table, |t| t.segments().get(index as usize).map(|v| v.id as f64).ok_or(StoreError::BadSegment))
        .unwrap_or_else(|e| {
            fail(e);
            -1.0
        })
}

#[no_mangle]
pub extern "C" fn zs_seg_begin(table: u32, rows: u32) -> u32 {
    // Purpose: start a new segment of `rows` rows
    status(with_table(table, |t| t.begin(rows)))
}

#[no_mangle]
pub extern "C" fn zs_seg_values(table: u32, column: u32) -> *mut u8 {
    // Purpose: the block the host fills with a column's values (rows times the type's width bytes)
    pointer(with_table(table, |t| t.values_ptr(column as usize)))
}

#[no_mangle]
pub extern "C" fn zs_seg_valid(table: u32, column: u32) -> *mut u8 {
    // Purpose: the block the host fills with a column's validity bytes (1 present, 0 null)
    pointer(with_table(table, |t| t.valid_ptr(column as usize)))
}

#[no_mangle]
pub extern "C" fn zs_seg_dict(table: u32, column: u32, entries: u32) -> u32 {
    // Purpose: say how many dictionary entries a code column's codes refer to
    status(with_table(table, |t| t.set_dict_len(column as usize, entries)))
}

#[no_mangle]
pub extern "C" fn zs_seg_commit(table: u32) -> u32 {
    // Purpose: check the staged segment and add it to the table, or leave the table unchanged and return the error
    status(with_table(table, |t| t.commit()))
}

#[no_mangle]
pub extern "C" fn zs_seg_abort(table: u32) -> u32 {
    // Purpose: throw away the staged segment
    status(with_table(table, |t| {
        t.abort();
        Ok(())
    }))
}

#[no_mangle]
pub extern "C" fn zs_snapshot(table: u32) -> u32 {
    // Purpose: freeze the table as it stands for one run; returns a handle (0 on error) to give back with zs_snapshot_free
    match with_table(table, |t| Ok(t.snapshot())) {
        Ok(s) => REGISTRY.with(|r| place(&mut r.borrow_mut().snapshots, s)),
        Err(e) => {
            fail(e);
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_snapshot_free(snapshot: u32) -> u32 {
    // Purpose: release a snapshot; segments no table or snapshot refers to are freed
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        match (snapshot as usize).checked_sub(1).and_then(|i| r.snapshots.get_mut(i)) {
            Some(slot) if slot.is_some() => {
                *slot = None;
                0
            }
            _ => fail(StoreError::BadHandle),
        }
    })
}

#[no_mangle]
pub extern "C" fn zs_snapshot_rows(snapshot: u32) -> f64 {
    // Purpose: rows in the snapshot (-1 for a bad handle)
    with_snapshot(snapshot, |s| Ok(s.rows as f64)).unwrap_or_else(|e| {
        fail(e);
        -1.0
    })
}

#[no_mangle]
pub extern "C" fn zs_snapshot_segments(snapshot: u32) -> u32 {
    // Purpose: number of segments in the snapshot (0 for a bad handle)
    with_snapshot(snapshot, |s| Ok(s.segments.len() as u32)).unwrap_or_else(|e| {
        fail(e);
        0
    })
}

#[no_mangle]
pub extern "C" fn zs_snapshot_segment_id(snapshot: u32, index: u32) -> f64 {
    // Purpose: the id of a segment, which the host uses to find the dictionaries it kept for it (-1 on error)
    with_snapshot(snapshot, |s| s.segments.get(index as usize).map(|v| v.id as f64).ok_or(StoreError::BadSegment))
        .unwrap_or_else(|e| {
            fail(e);
            -1.0
        })
}

#[no_mangle]
pub extern "C" fn zs_snapshot_segment_rows(snapshot: u32, index: u32) -> u32 {
    // Purpose: rows of a segment as the snapshot sees it
    with_snapshot(snapshot, |s| s.segments.get(index as usize).map(|v| v.rows).ok_or(StoreError::BadSegment))
        .unwrap_or_else(|e| {
            fail(e);
            0
        })
}

#[no_mangle]
pub extern "C" fn zs_snapshot_values(snapshot: u32, index: u32, column: u32) -> *const u8 {
    // Purpose: where a segment's values for a column start, for the host to read (null on error)
    let r = with_snapshot(snapshot, |s| {
        let v = s.segments.get(index as usize).ok_or(StoreError::BadSegment)?;
        if column as usize >= v.column_count() {
            return Err(StoreError::BadColumn);
        }
        Ok(v.values_ptr(column as usize))
    });
    match r {
        Ok(p) => p,
        Err(e) => {
            fail(e);
            std::ptr::null()
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_snapshot_valid(snapshot: u32, index: u32, column: u32) -> *const u8 {
    // Purpose: where a segment's validity bytes for a column start; null when nothing in the column is null, or on error (check zs_store_error)
    LAST_ERROR.with(|c| c.set(0));
    let r = with_snapshot(snapshot, |s| {
        let v = s.segments.get(index as usize).ok_or(StoreError::BadSegment)?;
        if column as usize >= v.column_count() {
            return Err(StoreError::BadColumn);
        }
        Ok(v.valid(column as usize).map_or(std::ptr::null(), |b| b.as_ptr()))
    });
    match r {
        Ok(p) => p,
        Err(e) => {
            fail(e);
            std::ptr::null()
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_snapshot_dict_len(snapshot: u32, index: u32, column: u32) -> u32 {
    // Purpose: dictionary entries a segment's column refers to (0 for other types or on error)
    with_snapshot(snapshot, |s| {
        let v = s.segments.get(index as usize).ok_or(StoreError::BadSegment)?;
        if column as usize >= v.column_count() {
            return Err(StoreError::BadColumn);
        }
        Ok(v.dict_len(column as usize))
    })
    .unwrap_or_else(|e| {
        fail(e);
        0
    })
}

#[no_mangle]
pub extern "C" fn zs_type_width(id: u8) -> u32 {
    // Purpose: bytes per value of a type id, 0 if there is no such type
    Type::from_id(id).map_or(0, |t| width(t) as u32)
}
