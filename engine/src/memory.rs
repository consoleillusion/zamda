// The engine's memory accounting and byte limit (T-410). Every allocation in the
// module goes through this allocator, which keeps the number of live bytes and
// refuses an allocation that would take the total past the limit the host set
// (the allocation then fails the way an out-of-memory allocation does: the table
// store and the host's blocks report error 210, and anything that cannot fail
// ends in a trap the host recovers from by making a new module).
//
// Runs also stop themselves before the limit: `soft_exceeded` is true once live
// bytes pass three quarters of the limit, and a run checks it before each chunk
// and ends with error 210, so a plan that is simply too big for the budget gets a
// typed error and not a trap. A single step can still grow past the quarter that
// is left (a hash table doubling, a sort of every row); that is the case the trap
// recovery is for.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

pub struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
// usize::MAX: no limit.
static LIMIT: AtomicUsize = AtomicUsize::new(usize::MAX);
static REFUSED: AtomicBool = AtomicBool::new(false);

fn add(size: usize) -> bool {
    // Purpose: count `size` more live bytes; false (and nothing counted) if that passes the limit
    let now = LIVE.fetch_add(size, Relaxed).wrapping_add(size);
    if now > LIMIT.load(Relaxed) {
        LIVE.fetch_sub(size, Relaxed);
        REFUSED.store(true, Relaxed);
        return false;
    }
    PEAK.fetch_max(now, Relaxed);
    true
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !add(layout.size()) {
            return std::ptr::null_mut();
        }
        let p = System.alloc(layout);
        if p.is_null() {
            LIVE.fetch_sub(layout.size(), Relaxed);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !add(layout.size()) {
            return std::ptr::null_mut();
        }
        let p = System.alloc_zeroed(layout);
        if p.is_null() {
            LIVE.fetch_sub(layout.size(), Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        LIVE.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old = layout.size();
        if new_size > old && !add(new_size - old) {
            return std::ptr::null_mut();
        }
        let p = System.realloc(ptr, layout, new_size);
        if p.is_null() {
            if new_size > old {
                LIVE.fetch_sub(new_size - old, Relaxed);
            }
        } else if new_size < old {
            LIVE.fetch_sub(old - new_size, Relaxed);
        }
        p
    }
}

pub fn live() -> usize {
    // Purpose: bytes the module has allocated and not freed
    LIVE.load(Relaxed)
}

pub fn soft_exceeded() -> bool {
    // Purpose: whether live bytes are past three quarters of the limit (false with no limit)
    let limit = LIMIT.load(Relaxed);
    limit != usize::MAX && live() > limit - limit / 4
}

#[no_mangle]
pub extern "C" fn zs_memory_limit(bytes: usize) {
    // Purpose: set the most bytes the module may hold; 0 removes the limit. A limit below what is live already only refuses new allocations.
    LIMIT.store(if bytes == 0 { usize::MAX } else { bytes }, Relaxed);
    REFUSED.store(false, Relaxed);
}

#[no_mangle]
pub extern "C" fn zs_memory_live() -> usize {
    // Purpose: bytes the module holds now
    live()
}

#[no_mangle]
pub extern "C" fn zs_memory_peak() -> usize {
    // Purpose: the most bytes the module has held since it started or since the peak was last reset
    PEAK.swap(live(), Relaxed)
}

#[no_mangle]
pub extern "C" fn zs_memory_refused() -> u32 {
    // Purpose: 1 if an allocation was refused for passing the limit since the limit was set (read this after a trap to tell a memory limit from a bug)
    REFUSED.load(Relaxed) as u32
}
