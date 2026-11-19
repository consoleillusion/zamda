// Tables in the engine's memory: a table is a list of immutable SEGMENTS (the
// rows it started with, then one per append), the same shape as the JS backend
// (C-LIVE). Segments are shared by reference counting, so a snapshot taken at
// the start of a run keeps seeing exactly that table while appends and the
// retain window replace the table's list.
//
// Strings never enter this crate: a utf8 or dictionary column is a column of
// int32 codes plus the number of dictionary entries (`dict_len`); the host keeps
// the strings. Validity is one byte per row (1 = present) and is dropped from a
// segment when nothing in it is null. Compaction may share one set of buffers
// between several views, but keeps each view's dictionary sizes and validity
// flags. Every buffer is 8-byte aligned, so any element type can be read in place.

use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::ptr::NonNull;
use std::rc::Rc;

use crate::types::Type;

// Compaction merges a tail run of at least this many small appends, holding no
// more than COMPACT_MAX_ROWS rows together, into one shared set of buffers.
const COMPACT_MIN_SEGMENTS: usize = 16;
const COMPACT_MAX_ROWS: u64 = 65_536;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum StoreError {
    NoColumns = 201,
    BadTypeId = 202,
    BadHandle = 203,
    NotStaged = 204,
    BadColumn = 205,
    MissingColumn = 206,
    BadValidity = 207,
    MissingDictLen = 208,
    CodeOutOfRange = 209,
    OutOfMemory = 210,
    BadSegment = 211,
}

pub fn width(ty: Type) -> usize {
    // Purpose: bytes one value of this type takes in a column (dictionary and utf8 columns hold int32 codes)
    match ty {
        Type::Bool | Type::Int8 | Type::Uint8 => 1,
        Type::Int16 | Type::Uint16 => 2,
        Type::Int32 | Type::Uint32 | Type::Float32 | Type::Utf8 | Type::Dictionary | Type::Date32 => 4,
        Type::Int64 | Type::Uint64 | Type::Float64 | Type::Timestamp => 8,
    }
}

fn has_codes(ty: Type) -> bool {
    // Purpose: whether the column stores dictionary codes instead of values
    matches!(ty, Type::Utf8 | Type::Dictionary)
}

// A zeroed, 8-byte aligned block of bytes.
struct Buf {
    ptr: NonNull<u8>,
    len: usize,
}

impl Buf {
    fn zeroed(len: usize) -> Result<Buf, StoreError> {
        // Purpose: allocate `len` zero bytes, reporting failure instead of aborting
        let layout = Layout::from_size_align(len.max(1), 8).map_err(|_| StoreError::OutOfMemory)?;
        let raw = unsafe { alloc_zeroed(layout) };
        match NonNull::new(raw) {
            Some(ptr) => Ok(Buf { ptr, len }),
            None => Err(StoreError::OutOfMemory),
        }
    }

    fn bytes(&self) -> &[u8] {
        // Purpose: the block as bytes
        unsafe { std::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
    }

    fn as_mut_ptr(&mut self) -> *mut u8 {
        // Purpose: where the host writes
        self.ptr.as_ptr()
    }
}

impl Drop for Buf {
    fn drop(&mut self) {
        // Purpose: give the block back
        let layout = Layout::from_size_align(self.len.max(1), 8).unwrap();
        unsafe { dealloc(self.ptr.as_ptr(), layout) }
    }
}

// A value type that can be read straight out of a column's bytes.
pub trait Cell: Copy {}
impl Cell for i8 {}
impl Cell for i16 {}
impl Cell for i32 {}
impl Cell for i64 {}
impl Cell for u8 {}
impl Cell for u16 {}
impl Cell for u32 {}
impl Cell for u64 {}
impl Cell for f32 {}
impl Cell for f64 {}

struct Column {
    ty: Type,
    values: Buf,
    // None when no view of the segment has validity bytes; whether a given view
    // uses them, and which dictionary its codes belong to, is on the view.
    valid: Option<Buf>,
}

struct SegmentData {
    columns: Vec<Column>,
}

// A segment, or the part of one that the retain window has not dropped yet.
// Several views may share one SegmentData after compaction: each keeps its own
// id, row range and per-column dictionary sizes, so neither a snapshot nor the
// host's per-segment dictionaries can tell that the buffers were shared.
#[derive(Clone)]
pub struct View {
    pub id: u64,
    data: Rc<SegmentData>,
    offset: u32,
    pub rows: u32,
    dict_lens: Vec<u32>,
    has_valid: Vec<bool>,
    compact_id: u64,
}

impl View {
    pub fn values<T: Cell>(&self, col: usize) -> &[T] {
        // Purpose: the column's values for this view's rows, read in place; T must have the column type's width
        let c = &self.data.columns[col];
        assert_eq!(std::mem::size_of::<T>(), width(c.ty), "wrong element type for the column");
        let all = unsafe { std::slice::from_raw_parts(c.values.ptr.as_ptr() as *const T, c.values.len / width(c.ty)) };
        &all[self.offset as usize..(self.offset + self.rows) as usize]
    }

    pub fn valid(&self, col: usize) -> Option<&[u8]> {
        // Purpose: this view's validity bytes, or None when the segment it came from had none
        if !self.has_valid[col] {
            return None;
        }
        let c = &self.data.columns[col];
        c.valid.as_ref().map(|v| &v.bytes()[self.offset as usize..(self.offset + self.rows) as usize])
    }

    pub fn dict_len(&self, col: usize) -> u32 {
        // Purpose: how many dictionary entries this view's codes may refer to (0 for other types)
        self.dict_lens[col]
    }

    pub fn column_type(&self, col: usize) -> Type {
        // Purpose: the data type of a column
        self.data.columns[col].ty
    }

    pub fn column_count(&self) -> usize {
        // Purpose: number of columns in the segment
        self.data.columns.len()
    }

    pub fn values_ptr(&self, col: usize) -> *const u8 {
        // Purpose: address of this view's first value in the column, for the host to read
        let c = &self.data.columns[col];
        unsafe { c.values.ptr.as_ptr().add(self.offset as usize * width(c.ty)) as *const u8 }
    }

    // Purpose: how many rows the retain window has dropped from the front of the segment this view sees (two views of one segment with different offsets cover different rows, so a cache key needs it)
    pub fn offset(&self) -> u64 {
        self.offset as u64
    }

    pub fn has_nulls(&self, col: usize) -> bool {
        // Purpose: whether any row this view sees is null in this column
        self.valid(col).map_or(false, |v| v.iter().any(|&b| b == 0))
    }

    pub fn shares_storage_with(&self, other: &View) -> bool {
        // Purpose: whether two views read the same compacted buffers (for tests of compaction)
        Rc::ptr_eq(&self.data, &other.data)
    }
}

// The table as it stood at one moment.
#[derive(Clone)]
pub struct Snapshot {
    pub segments: Vec<View>,
    pub rows: u64,
}

#[derive(Default)]
struct StagedColumn {
    values: Option<Buf>,
    valid: Option<Buf>,
    dict_len: Option<u32>,
}

thread_local! {
    static NEXT_SEGMENT_ID: std::cell::Cell<u64> = const { std::cell::Cell::new(1) };
    static NEXT_COMPACT_ID: std::cell::Cell<u64> = const { std::cell::Cell::new(1) };
}

struct Staging {
    rows: u32,
    columns: Vec<StagedColumn>,
}

pub struct Table {
    types: Vec<Type>,
    // u32::MAX means no retain window (a table cannot hold more rows than that).
    retain: u32,
    segments: Vec<View>,
    rows: u64,
    dropped: u64,
    next_id: u64,
    staging: Option<Staging>,
}

impl Table {
    pub fn new(types: &[Type], retain: Option<u32>) -> Result<Table, StoreError> {
        // Purpose: an empty table for these column types, keeping at most `retain` rows if given
        if types.is_empty() {
            return Err(StoreError::NoColumns);
        }
        Ok(Table {
            types: types.to_vec(),
            retain: retain.unwrap_or(u32::MAX),
            segments: Vec::new(),
            rows: 0,
            dropped: 0,
            next_id: 1,
            staging: None,
        })
    }

    pub fn rows(&self) -> u64 {
        // Purpose: rows in the table now
        self.rows
    }

    pub fn dropped(&self) -> u64 {
        // Purpose: rows removed so far by the retain window
        self.dropped
    }

    pub fn segments(&self) -> &[View] {
        // Purpose: the segments in order, oldest first
        &self.segments
    }

    pub fn snapshot(&self) -> Snapshot {
        // Purpose: the table as it stands; later appends and drops do not change it
        Snapshot { segments: self.segments.clone(), rows: self.rows }
    }

    pub fn begin(&mut self, rows: u32) -> Result<(), StoreError> {
        // Purpose: start a new segment of `rows` rows, discarding any segment started before and not committed
        let columns = (0..self.types.len()).map(|_| StagedColumn::default()).collect();
        self.staging = Some(Staging { rows, columns });
        Ok(())
    }

    fn staged(&mut self, col: usize) -> Result<(&mut Staging, Type), StoreError> {
        // Purpose: the segment being staged and a column's type, checking both exist
        let ty = *self.types.get(col).ok_or(StoreError::BadColumn)?;
        let staging = self.staging.as_mut().ok_or(StoreError::NotStaged)?;
        Ok((staging, ty))
    }

    pub fn values_ptr(&mut self, col: usize) -> Result<*mut u8, StoreError> {
        // Purpose: where the host writes the column's values for the staged segment (allocated zeroed on first use)
        let (staging, ty) = self.staged(col)?;
        let bytes = (staging.rows as usize).checked_mul(width(ty)).ok_or(StoreError::OutOfMemory)?;
        let slot = &mut staging.columns[col].values;
        if slot.is_none() {
            *slot = Some(Buf::zeroed(bytes)?);
        }
        Ok(slot.as_mut().unwrap().as_mut_ptr())
    }

    pub fn valid_ptr(&mut self, col: usize) -> Result<*mut u8, StoreError> {
        // Purpose: where the host writes the column's validity bytes (one per row, 1 = present); a column never asked for has no nulls
        let (staging, _) = self.staged(col)?;
        let rows = staging.rows as usize;
        let slot = &mut staging.columns[col].valid;
        if slot.is_none() {
            *slot = Some(Buf::zeroed(rows)?);
        }
        Ok(slot.as_mut().unwrap().as_mut_ptr())
    }

    pub fn set_dict_len(&mut self, col: usize, len: u32) -> Result<(), StoreError> {
        // Purpose: record how many dictionary entries a code column's codes may refer to
        let (staging, _) = self.staged(col)?;
        staging.columns[col].dict_len = Some(len);
        Ok(())
    }

    pub fn abort(&mut self) {
        // Purpose: throw away the staged segment
        self.staging = None;
    }

    pub fn commit(&mut self) -> Result<(), StoreError> {
        // Purpose: check the staged segment whole and add it; on any error the table is unchanged and the staged segment is gone
        let staging = self.staging.take().ok_or(StoreError::NotStaged)?;
        let rows = staging.rows as usize;
        let mut columns = Vec::with_capacity(self.types.len());
        let mut dict_lens = Vec::with_capacity(self.types.len());
        let mut has_valid = Vec::with_capacity(self.types.len());
        for (index, staged) in staging.columns.into_iter().enumerate() {
            let ty = self.types[index];
            let values = staged.values.ok_or(StoreError::MissingColumn)?;
            let mut valid = staged.valid;
            let mut nulls = 0u32;
            if let Some(v) = &valid {
                for &b in v.bytes() {
                    match b {
                        0 => nulls += 1,
                        1 => {}
                        _ => return Err(StoreError::BadValidity),
                    }
                }
                if nulls == 0 {
                    valid = None;
                }
            }
            let mut dict_len = 0;
            if has_codes(ty) {
                dict_len = staged.dict_len.ok_or(StoreError::MissingDictLen)?;
                let codes = unsafe { std::slice::from_raw_parts(values.ptr.as_ptr() as *const i32, rows) };
                let present = valid.as_ref().map(|v| v.bytes());
                for (i, &code) in codes.iter().enumerate() {
                    // A negative code wraps to a huge u32, so one comparison covers both ends.
                    if present.map_or(true, |v| v[i] != 0) && code as u32 >= dict_len {
                        return Err(StoreError::CodeOutOfRange);
                    }
                }
            }
            has_valid.push(valid.is_some());
            dict_lens.push(dict_len);
            columns.push(Column { ty, values, valid });
        }
        if rows == 0 {
            return Ok(());
        }
        // Segment ids are unique across every table of the module (not only this one), because the session cache keys its entries by segment id.
        let id = NEXT_SEGMENT_ID.with(|n| {
            let id = n.get();
            n.set(id + 1);
            id
        });
        self.next_id = id + 1;
        self.segments.push(View {
            id,
            data: Rc::new(SegmentData { columns }),
            offset: 0,
            rows: staging.rows,
            dict_lens,
            has_valid,
            compact_id: 0,
        });
        self.rows += rows as u64;
        self.enforce_retain();
        self.compact_tail();
        Ok(())
    }

    fn compact_tail(&mut self) {
        // Purpose: copy a run of small new segments into shared buffers, keeping every view's id, rows, codes and validity
        let mut start = self.segments.len();
        let mut rows = 0u64;
        while start > 0 {
            let view = &self.segments[start - 1];
            if view.compact_id != 0 {
                break;
            }
            let more = rows + view.rows as u64;
            if more > COMPACT_MAX_ROWS {
                break;
            }
            rows = more;
            start -= 1;
        }
        if self.segments.len() - start < COMPACT_MIN_SEGMENTS {
            return;
        }
        // Under memory pressure compaction is optional: if a block cannot be
        // allocated, leave the table exactly as it was and try again next time.
        if crate::memory::soft_exceeded() {
            return;
        }
        let total = rows as usize;
        let mut columns = Vec::with_capacity(self.types.len());
        for (col, ty) in self.types.iter().enumerate() {
            let w = width(*ty);
            let bytes = match total.checked_mul(w) {
                Some(bytes) => bytes,
                None => return,
            };
            let mut values = match Buf::zeroed(bytes) {
                Ok(buf) => buf,
                Err(_) => return,
            };
            let any_valid = self.segments[start..].iter().any(|v| v.has_valid[col]);
            let mut valid = if any_valid {
                match Buf::zeroed(total) {
                    Ok(buf) => Some(buf),
                    Err(_) => return,
                }
            } else {
                None
            };
            let to = values.as_mut_ptr();
            let mut at = 0usize;
            for view in &self.segments[start..] {
                let n = view.rows as usize;
                unsafe {
                    std::ptr::copy_nonoverlapping(view.values_ptr(col), to.add(at * w), n * w);
                    if let Some(valid) = &mut valid {
                        let bytes = valid.as_mut_ptr().add(at);
                        match view.valid(col) {
                            Some(v) => std::ptr::copy_nonoverlapping(v.as_ptr(), bytes, n),
                            None => std::ptr::write_bytes(bytes, 1, n),
                        }
                    }
                }
                at += n;
            }
            columns.push(Column { ty: *ty, values, valid });
        }
        let compact_id = NEXT_COMPACT_ID.with(|n| {
            let id = n.get();
            n.set(id + 1);
            id
        });
        let data = Rc::new(SegmentData { columns });
        let mut views = Vec::with_capacity(self.segments.len() - start);
        let mut offset = 0u32;
        for old in &self.segments[start..] {
            views.push(View {
                id: old.id,
                data: data.clone(),
                offset,
                rows: old.rows,
                dict_lens: old.dict_lens.clone(),
                has_valid: old.has_valid.clone(),
                compact_id,
            });
            offset += old.rows;
        }
        self.segments.truncate(start);
        self.segments.extend(views);
    }

    fn enforce_retain(&mut self) {
        // Purpose: drop the oldest rows until at most `retain` remain; whole segments go, the first kept one may lose its front
        if self.rows <= self.retain as u64 {
            return;
        }
        let mut excess = self.rows - self.retain as u64;
        self.dropped += excess;
        self.rows = self.retain as u64;
        let mut kept = Vec::with_capacity(self.segments.len());
        for mut view in self.segments.drain(..) {
            if excess >= view.rows as u64 {
                excess -= view.rows as u64;
                continue;
            }
            if excess > 0 {
                view.offset += excess as u32;
                view.rows -= excess as u32;
                excess = 0;
            }
            kept.push(view);
        }
        self.segments = kept;
    }
}
