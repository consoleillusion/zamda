// The C interface for running a plan (T-405): create a run over a snapshot,
// step it chunk by chunk (so the host can return to its event loop between
// steps), then read the result columns.

use crate::eval_abi::{eval_error, place, release, set_error, EvalResult, BAD_ARGUMENT, BAD_HANDLE, REGISTRY, SCHEMA_MISMATCH};
use crate::exec::Run;
use crate::store_abi::with_snapshot;

fn get<T: Clone>(slots: &[Option<T>], handle: u32) -> Option<T> {
    // Purpose: a copy of what a handle refers to
    (handle as usize).checked_sub(1).and_then(|i| slots.get(i)).and_then(|s| s.clone())
}

#[no_mangle]
pub extern "C" fn zs_run_new(plan: u32, params: u32, snapshot: u32, chunk_rows: u32) -> u32 {
    // Purpose: prepare a run of a plan over a snapshot; returns a handle, 0 on error (303 when the engine cannot run the plan)
    let handles = REGISTRY.with(|r| {
        let r = r.borrow();
        (get(&r.plans, plan), get(&r.params, params))
    });
    let (Some(plan), Some(params)) = handles else {
        set_error(BAD_HANDLE, 0, 0);
        return 0;
    };
    let taken = with_snapshot(snapshot, |s| Ok(s.clone()));
    let snapshot = match taken {
        Ok(s) => s,
        Err(e) => {
            set_error(e as u32, 0, 0);
            return 0;
        }
    };
    let matches_plan = snapshot.segments.iter().all(|v| {
        v.column_count() == plan.input.len() && (0..plan.input.len()).all(|c| v.column_type(c) == plan.input[c].ty)
    });
    if !matches_plan {
        set_error(SCHEMA_MISMATCH, 0, 0);
        return 0;
    }
    let rows = if chunk_rows == 0 { crate::eval::BATCH_ROWS } else { (chunk_rows as usize).min(crate::eval::BATCH_ROWS) };
    match Run::new(plan, params, snapshot, rows) {
        Ok(run) => REGISTRY.with(|r| place(&mut r.borrow_mut().runs, run)),
        Err(e) => {
            eval_error(&e);
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_run_step(run: u32) -> u32 {
    // Purpose: process one chunk; 0 = more to do, 1 = finished, anything else is an error code (zs_eval_error has the details)
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let Some(Some(run)) = (run as usize).checked_sub(1).and_then(|i| r.runs.get_mut(i)) else {
            return set_error(BAD_HANDLE, 0, 0);
        };
        match run.step() {
            Ok(done) => done as u32,
            Err(e) => eval_error(&e),
        }
    })
}

#[no_mangle]
pub extern "C" fn zs_run_scanned(run: u32) -> u64 {
    // Purpose: table rows read so far
    REGISTRY.with(|r| {
        let r = r.borrow();
        (run as usize).checked_sub(1).and_then(|i| r.runs.get(i)).and_then(|x| x.as_ref()).map_or(0, |x| x.rows_scanned())
    })
}

#[no_mangle]
pub extern "C" fn zs_run_finish(run: u32) -> u32 {
    // Purpose: end a finished run and keep its columns; returns how many (read them with zs_run_column), 0 with an error for an unfinished run
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let slot = match (run as usize).checked_sub(1).and_then(|i| r.runs.get_mut(i)) {
            Some(s) if s.as_ref().is_some_and(|x| x.is_finished()) => s,
            Some(s) if s.is_some() => return set_error(BAD_ARGUMENT, 0, 0),
            _ => return set_error(BAD_HANDLE, 0, 0),
        };
        let columns = slot.take().expect("checked above").finish();
        let n = columns.len() as u32;
        let handles: Vec<u32> = columns
            .into_iter()
            .map(|c| {
                let rows = c.values.len();
                place(&mut r.results, EvalResult { ty: c.ty, rows, values: c.values, valid: c.valid })
            })
            .collect();
        FINISHED.with(|f| *f.borrow_mut() = handles);
        n
    })
}

thread_local! {
    // Result handles of the columns of the last finished run.
    static FINISHED: std::cell::RefCell<Vec<u32>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn zs_run_column(index: u32) -> u32 {
    // Purpose: the result handle (see zs_result_*) of a column of the last finished run; 0 if there is none
    FINISHED.with(|f| f.borrow().get(index as usize).copied().unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn zs_run_free(run: u32) -> u32 {
    // Purpose: free a run that is not finished (a finished run is already gone)
    REGISTRY.with(|r| release(&mut r.borrow_mut().runs, run))
}

#[no_mangle]
pub extern "C" fn zs_run_canon(run: u32, column: u32, segment: u32, ptr: *const u32, len: usize) -> u32 {
    // Purpose: give a utf8 or dictionary column's segment its map from codes to canonical ids (one u32 per code); 0 on success
    let map = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let Some(Some(run)) = (run as usize).checked_sub(1).and_then(|i| r.runs.get_mut(i)) else {
            return set_error(BAD_HANDLE, 0, 0);
        };
        if run.set_canon(column as usize, segment as usize, map) {
            0
        } else {
            set_error(BAD_ARGUMENT, 0, 0)
        }
    })
}
