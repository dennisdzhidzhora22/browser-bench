//! Holder for kernel state that `prepare` writes and `run` reads.

use core::cell::UnsafeCell;

/// A global cell for single-threaded wasm. Each wasm instance lives in one
/// worker and is never shared across threads, so plain access is sound as
/// long as callers don't keep two `&mut` from `get` alive at once.
pub struct Global<T>(UnsafeCell<T>);

// SAFETY: this crate is built without the wasm `atomics` feature, so an
// instance is only ever touched by one thread.
unsafe impl<T> Sync for Global<T> {}

impl<T> Global<T> {
    pub const fn new(value: T) -> Self {
        Self(UnsafeCell::new(value))
    }

    /// # Safety
    /// Do not hold the returned reference across another `get` on the same cell.
    #[allow(clippy::mut_from_ref)]
    pub unsafe fn get(&self) -> &mut T {
        // SAFETY: see type-level comment.
        unsafe { &mut *self.0.get() }
    }
}
