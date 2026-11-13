//! Benchmark kernels, compiled to `wasm32-unknown-unknown`.
//!
//! # ABI (docs/SPEC.md, D2)
//!
//! Every kernel `<id>` exports exactly two functions:
//!
//! - `<id>_prepare(seed: u32, size: u32) -> u32` — untimed. Allocates buffers
//!   from the arena and fills inputs. Returns 0 on success, nonzero on failure
//!   (for example 1 = out of memory).
//! - `<id>_run() -> u32` — timed. Does the work on the prepared inputs and
//!   returns a checksum. It must be idempotent: calling it N times after one
//!   `prepare` returns the same checksum every time. If the work mutates its
//!   input (sorting, compressing in place), copy the pristine input into a work
//!   buffer at the start of `run`; that copy is part of the measured work.
//!
//! Rules: plain `extern "C"`, no wasm-bindgen, only `u32` crosses the boundary,
//! deterministic output, no `std` (so no libm: write your own `sin`/`cos`/`exp`
//! approximations from `+ - * /` and `sqrt` if needed, so results are bit-exact
//! across browsers and mirrorable in JS). Floats feed the checksum through
//! `checksum::f64_bits`.

#![no_std]

pub mod arena;
pub mod checksum;
pub mod global;

mod mix;

/// Bumped whenever any kernel's work, sizes or checksum changes. JS checks this
/// against `ABI_VERSION` in src/lib/harness/wasm.ts.
#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    2
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
