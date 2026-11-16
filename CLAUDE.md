# browser-bench — working rules

Read `docs/SPEC.md` first. It holds the goals, settled decisions (D1–D10), overhead rules
(section 7), agent roles (section 11) and milestones (section 12). Don't re-decide what it settles.

## Commands (Windows, from the repo root)

```
npm run build      Rust -> wasm (scripts/build-wasm.mjs) + vite build
npm run check      build + svelte-check + cargo fmt/clippy + vitest + size budget
npm run e2e        build + Playwright (installed Chrome) against vite preview
npm run dev        dev server, 127.0.0.1:5173 (scores not valid)
npm run preview    production build, 127.0.0.1:4173
node scripts/make-reference.mjs <export.json> [<run id>|latest] [--name "Owner PC"] [--freeze]
                   reference entry from an exported Full run (SPEC 6); --freeze also rewrites
                   the constants. --freeze is the owner's step: agents never run it. A second
                   --freeze refuses (constants already frozen) and changes nothing.
```

A milestone is done only when `npm run check` and `npm run e2e` both pass. Report skipped
tests as skipped.

## Rules

- Rust kernels: zero dependencies, `no_std`, raw `extern "C"` exports, only `u32` across the
  boundary. Each kernel `<id>` exports `<id>_prepare(seed, size) -> status` (untimed) and
  `<id>_run() -> checksum` (timed, idempotent). Full contract: top of `kernels/src/lib.rs`.
  Buffers come from `kernels/src/arena.rs`; shared RNG/checksum helpers in `checksum.rs`.
- Each kernel has a `KernelDef` (`src/lib/bench/types.ts`) with sizes, expected checksums and
  a `work(size)` function; CPU kernels are listed in `src/lib/bench/cpu/index.ts`.
- A kernel's reference algorithm is documented in its `.rs` file so tests can mirror it in JS.
- Any change to a kernel's work or checksum bumps `abi_version()` in `kernels/src/lib.rs` and
  `ABI_VERSION` in `src/lib/harness/wasm.ts`.
- Timing happens in workers. Nothing is posted, allocated or logged inside a timed region.
- No new runtime dependencies beyond Svelte. Dev dependencies only when used.
- Servers bind to 127.0.0.1 only.
- Tests never assert on speed, only on correctness and structure.
- Role file ownership: Builder edits `src/`, `kernels/`, `scripts/`, config; Tester edits
  `tests/` only; Reviewer edits nothing.
