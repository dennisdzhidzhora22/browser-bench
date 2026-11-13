//! Bump allocator over wasm linear memory.
//!
//! `prepare` functions call `reset()` first, then `alloc_slice` for each
//! buffer. Memory grows on demand and never shrinks; reset only rewinds the
//! bump pointer. One wasm instance runs one kernel at a time, so a single
//! global arena is enough.

use core::arch::wasm32;
use core::sync::atomic::{AtomicUsize, Ordering::Relaxed};

const PAGE: usize = 65_536;

/// Start of the arena: end of memory at first use. 0 = not yet initialised.
static BASE: AtomicUsize = AtomicUsize::new(0);
/// Next free byte.
static NEXT: AtomicUsize = AtomicUsize::new(0);

fn base() -> usize {
    let b = BASE.load(Relaxed);
    if b != 0 {
        return b;
    }
    // First call happens while memory is still small, so this cannot wrap.
    let b = wasm32::memory_size(0) * PAGE;
    BASE.store(b, Relaxed);
    NEXT.store(b, Relaxed);
    b
}

/// Rewinds the arena. Every slice handed out before is invalid afterwards.
pub fn reset() {
    let b = base();
    NEXT.store(b, Relaxed);
}

/// Allocates `len` zeroed-or-stale elements of `T`. Contents are NOT zeroed
/// after a reset; fill every element you read. Returns `None` when memory
/// cannot grow (the caller's `prepare` should then return 1).
pub fn alloc_slice<T: Copy>(len: usize) -> Option<&'static mut [T]> {
    base();
    let align = core::mem::align_of::<T>().max(16);
    let bytes = len.checked_mul(core::mem::size_of::<T>())?;
    let start = NEXT.load(Relaxed).checked_add(align - 1)? & !(align - 1);
    let end = start.checked_add(bytes)?;
    // In u64: at the full 4 GiB, pages * PAGE would wrap to 0 in usize.
    let have = wasm32::memory_size(0) as u64 * PAGE as u64;
    if end as u64 > have {
        let pages = (end as u64 - have).div_ceil(PAGE as u64) as usize;
        if wasm32::memory_grow(0, pages) == usize::MAX {
            return None;
        }
    }
    NEXT.store(end, Relaxed);
    // SAFETY: [start, end) is inside linear memory, aligned for T, and not
    // handed out again until the next reset(). T: Copy, so any bit pattern
    // left over is a valid value for the integer/float types kernels use.
    Some(unsafe { core::slice::from_raw_parts_mut(start as *mut T, len) })
}
