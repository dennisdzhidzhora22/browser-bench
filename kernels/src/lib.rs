//! Benchmark kernels, compiled to `wasm32-unknown-unknown`.
//!
//! ABI rules (docs/SPEC.md, D2):
//! - Plain `extern "C"` exports, no wasm-bindgen.
//! - Only `i32`/`u32`/`f64` cross the boundary, so JS never needs BigInt glue.
//! - Every kernel is deterministic: `(seed, size) -> checksum`.
//! - The JS side never runs code inside a timed region except the kernel call.
//!
//! The crate is `no_std` so the module has no imports and no allocator by
//! default. Kernels that need buffers get them from `alloc_*` exports added in
//! later milestones.

#![no_std]

mod mix;

/// Bumped whenever any kernel's work or checksum changes. JS checks this
/// against the value it was built for and refuses to run on a mismatch.
#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    1
}

/// M0 smoke kernel. See `mix.rs`.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mix(seed: u32, iterations: u32) -> u32 {
    mix::run(seed, iterations)
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
