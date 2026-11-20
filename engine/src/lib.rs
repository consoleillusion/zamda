// The zamda WASM engine. Plans are read and validated (T-402) and tables live in
// the engine's memory (T-403); the operators arrive in T-404 onward. See docs/TASKS.md, Milestone 3.

// The `zs_*` C-ABI entry points take raw pointers from the host (WASM memory offsets or FFI pointers)
// by design: the host is the only caller, and each entry point checks lengths and codes before use.
// Marking them `unsafe extern "C"` would change nothing for the host and only add noise to the tests.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

pub mod decode;
pub mod encode;
pub mod error;
pub mod agg;
pub mod eval_abi;
pub mod exec;
pub mod run_abi;
pub mod sort;
pub mod eval;
pub mod ir;
pub mod kernels;
pub mod memory;
pub mod signatures;
pub mod session;
pub mod store;
pub mod store_abi;
pub mod time;
pub mod types;
pub mod validate;
pub mod vector;

use std::sync::atomic::{AtomicU32, Ordering};

#[global_allocator]
static ALLOCATOR: memory::Counting = memory::Counting;

use error::Error;
use ir::Plan;

pub fn load_plan(bytes: &[u8]) -> Result<Plan, Error> {
    // Purpose: decode and validate a plan: the one way the engine accepts one
    let plan = decode::decode(bytes)?;
    validate::validate(&plan)?;
    Ok(plan)
}

static LAST_ERROR_AT: AtomicU32 = AtomicU32::new(0);

#[no_mangle]
pub extern "C" fn zs_plan_check(ptr: *const u8, len: usize) -> u32 {
    // Purpose: 0 if the bytes are a valid plan, otherwise the error code (see error.rs); zs_plan_error_at gives the position
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    match load_plan(bytes) {
        Ok(_) => 0,
        Err(e) => {
            LAST_ERROR_AT.store(e.at, Ordering::Relaxed);
            e.code as u32
        }
    }
}

#[no_mangle]
pub extern "C" fn zs_plan_error_at() -> u32 {
    // Purpose: the byte offset (decoding errors) or node index (validation errors) of the last failed zs_plan_check
    LAST_ERROR_AT.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn zs_alloc(bytes: usize) -> *mut u8 {
    // Purpose: give the host a block to write a plan into
    // A size no layout can hold (over isize::MAX) is refused with null, like any failed allocation,
    // instead of panicking, which would abort the module.
    match std::alloc::Layout::from_size_align(bytes.max(8), 8) {
        Ok(layout) => unsafe { std::alloc::alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn zs_free(ptr: *mut u8, bytes: usize) {
    // Purpose: return a block from zs_alloc
    if ptr.is_null() {
        return;
    }
    let Ok(layout) = std::alloc::Layout::from_size_align(bytes.max(8), 8) else { return };
    unsafe { std::alloc::dealloc(ptr, layout) }
}
