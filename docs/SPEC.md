# browser-bench — Specification

Status: approved scope, not yet built. Written 2026-11-13.
Working name: `browser-bench`. Repo: `C:\Users\denni\Repos\browser-bench`.

## 1. What this is

A web app that benchmarks and stress-tests a PC from inside the browser, in the spirit of
Geekbench / Cinebench. It runs entirely client-side. The user picks which components to test.

### Goals

- Measure CPU (single core), CPU (all cores), GPU, memory and storage.
- Let the user select any subset of components and a run mode.
- Keep everything that is *not* the benchmark as close to zero overhead as possible.
- Run locally first. Hosting comes later and must not require a redesign.

### Non-goals (v1)

- Online leaderboard, accounts, or any backend.
- Phones and tablets.
- Firefox and Safari (Chrome and Edge first; do not add code that blocks them later).
- Temperatures, fan speeds, power draw, exact CPU model, raw disk access. Browsers do not
  expose these. The app must say so plainly instead of guessing.

### Honest framing

Results are **browser scores**: the speed of this PC *through this browser*. WebAssembly reaches
roughly 70–95% of native speed for CPU work, and results vary with browser version. The UI
states this once on the results page and records browser name and version with every result.

## 2. Settled decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Benchmark kernels in Rust, compiled to WebAssembly. JavaScript variants only where the test is about the JS engine or a browser API. | WASM target is built into Rust; small output; one build tool. |
| D2 | Zero-dependency Rust crate, raw `extern "C"` exports, **no wasm-bindgen**. | No glue code in the timed path; no build scripts or proc-macros (see risk R1). |
| D3 | UI in Svelte 5 + TypeScript, built with Vite. | Compiles to direct DOM updates; a few kB of runtime; good dev flow. |
| D4 | All measured work runs in Web Workers. The page does no work while a measurement window is open. | Keeps UI cost out of scores. |
| D5 | The page is cross-origin isolated (COOP + COEP headers). | Unlocks `SharedArrayBuffer` and 5 µs timers. |
| D6 | Multi-core CPU test = one independent WASM instance per worker. No WASM threads/atomics build. | Works on stable Rust; no shared-memory contention inside kernels. |
| D7 | Raw numbers in real units are the headline. Reference-PC numbers are shown beside them. A points total is derived from fixed constants. | Owner decision. |
| D8 | Three run modes: Benchmark, Endurance, Stress. | Owner decision. |
| D9 | Results stored locally with JSON export/import. No network calls at all. | Owner decision. |
| D10 | Chrome and Edge are the supported browsers. | Owner decision. |

## 3. Components and tests

Every kernel is deterministic: fixed seed in, checksum out. The checksum is verified on every
run; a mismatch marks the result invalid. This is also the main correctness test (section 9).

Each kernel takes a `size` parameter. `smoke` sizes finish in milliseconds and exist only for
automated tests.

### 3.1 CPU — single core

One worker, one WASM instance.

| Kernel | Stresses | Unit |
|---|---|---|
| SHA-256 over a fixed buffer | integer, bit ops | MB/s |
| LZ-style compress + decompress | branches, memory access | MB/s |
| Sort (u32 and f64 arrays) | branches, cache | M elements/s |
| N-body simulation | scalar float | steps/s |
| Mandelbrot | float, tight loops | Mpixels/s |
| Matrix multiply (f64) | float, cache | GFLOP/s |
| FFT | float | transforms/s |
| Path tracer (small fixed scene) | mixed float, branches | ksamples/s |
| SIMD variants of matrix multiply and Mandelbrot | `simd128` | same units |

Build with `-C target-feature=+simd128` and `opt-level=3`. Kernels are original code written
for this project, not ports of another benchmark's workloads.

### 3.2 CPU — all cores

Same kernels, `navigator.hardwareConcurrency` workers started together with a shared start
signal (`Atomics.notify` on a `SharedArrayBuffer`). Reports summed throughput and the scaling
ratio. Worker count is user-adjustable.

How it works (M2):

- Kernels whose standard size needs a lot of memory have a smaller `multi` size, so one
  instance per core stays under ~16 MB of wasm memory each.
- `multi` sizes also keep each `run` short (~25–50 ms) so timed windows are fine-grained.
- Every sample is released by a shared barrier. Each worker runs `run` for a fixed-time
  window (150 ms Quick, 300 ms Full) and counts its reps. The sample's score is the **sum of
  every worker's rate**, so every core's work counts and one slow core does not hold the
  others back. (M2 review changed this from wall time, which measured the slowest core.)
- The scaling ratio's baseline is one worker running the same size and window inside this
  test, after a short spin, not the single-core component's result (which may use a
  different size).
- A worker that fails wakes the others and stops the group; barrier waits time out after
  30 s. The kernel is marked failed and the next kernel gets a fresh pool.

### 3.3 Memory

| Test | Unit |
|---|---|
| Sequential fill | GB/s |
| Sequential copy | GB/s |
| Random-access latency (pointer chase) at sizes from 16 KiB to 256 MiB | ns/access per size |
| Multi-worker copy (bandwidth under contention) | GB/s |

The latency curve shows the cache levels as steps. Default working set is capped at 1 GiB;
allocation failure is handled and reported, never thrown at the user.

How it works (M3): fill and copy use wasm bulk-memory instructions (`memory.fill`,
`memory.copy`), which the browser runs natively, so they show the best bandwidth web code can
reach. Fill uses 256 MB and copy 128 MB → 128 MB, past the largest desktop L3 caches. The
all-cores copy uses a separate kernel (`mem_copy_mt`, 16 MB → 16 MB per worker, few passes) so
one call stays short next to the timed window; with few workers its total can fit in cache,
and the UI says so. Copy bandwidth counts bytes copied once (memory traffic is about 2×), and
the UI says so. Latency follows a random single-cycle chain at cache-line stride; each hop is
one dependent load of a stored address, with no index arithmetic. The hop count grows with the
working set so every line is touched and each run lasts about 50 ms or more (SPEC 5.3).
17 working-set sizes from 16 KB to 256 MB, including 12 and 24 MB to locate the L3 → RAM
step. Peak wasm memory is about 272 MB (the 256 MB chain plus its shuffle table). The memory
component's run time is a soft limit. Automated runs (Playwright) launch Chrome with
background throttling turned off; a headless or background window otherwise gets lower clocks
and slow cores from Windows.

### 3.4 GPU

WebGPU first.

| Test | Unit |
|---|---|
| Compute shader: N-body | G interactions/s |
| Compute shader: matrix multiply | GFLOP/s |
| Render: many draw calls, offscreen target | K draws/s |
| Render: heavy fragment shader (ray-march), offscreen target | Mpixels/s |

Rules: render to an offscreen texture, never to a presented canvas, so results are not capped
by the display refresh rate. Time a batch with `queue.onSubmittedWorkDone()`. Record
`adapter.info`.

WebGL2 fallback runs only the fragment test and is labelled **fallback** in results. Fallback
results are never mixed into the same reference comparison as WebGPU results.

**Choosing the GPU (owner request, 2026-11-14).** Browsers do not list GPUs; they only take a
power preference. The user picks **Fast** (`high-performance`), **Power-saving**
(`low-power`) or **Both**. On dual-GPU PCs this usually means the dedicated and the built-in
GPU, but the browser and the OS (e.g. Windows per-app graphics settings) decide. Before the
run, the page asks for an adapter with each chosen preference and compares what the browser
reports; if both give the same GPU it is tested once and the page says so. Each tested GPU
gets its own results table, labelled with what the browser reports.

Limit (verified on the owner's PC: Arc 140T + RTX 5070 Ti, both preferences gave the 140T):
Chrome on Windows ignores the preference for WebGPU and uses one GPU for all its work, and
cannot use two GPUs at once. When "Both" finds one GPU, the page explains how to switch:
`chrome://flags/#force-high-performance-gpu`, or Windows per-app graphics settings, or one
browser per GPU. The choice is kept because other platforms (e.g. macOS) honor it.

How it works (M4): GPU tests run in `gpu.worker.ts`. Each test repeats its work to fill about
200 ms per sample (calibrated once). GPU float results differ between GPUs and drivers, so
instead of exact checksums each test reads back part of its output after timing and checks it
against a CPU reference within a stated tolerance.

### 3.5 Storage

OPFS with `createSyncAccessHandle` inside a worker.

| Test | Unit |
|---|---|
| Sequential write, then `flush()` | MB/s |
| Sequential read | MB/s |
| Random 4 KiB write | IOPS |
| Random 4 KiB read | IOPS |

Check `navigator.storage.estimate()` first and scale the file size to fit. Always delete test
files, including after errors and cancelled runs. The results page notes that the OS file
cache inflates read numbers and that the browser sits between the test and the disk.

### 3.6 System info (not scored)

User agent, browser version, logical core count, `deviceMemory` (coarse), GPU adapter info,
screen size, measured refresh rate, `crossOriginIsolated`. Collected once before a run.

## 4. Run modes

| Mode | Length | Output |
|---|---|---|
| Benchmark — Quick | a few minutes at most (1 min was a soft goal; owner OK'd ~70 s for CPU alone, 2026-11-13) | scores |
| Benchmark — Full | longer than Quick, soft limit | scores, tighter spread |
| Endurance | 10, 30 or 60 min, user picks | throughput over time, start vs end, drop % |
| Stress | until stopped | same chart, live |

Endurance and Stress loop the selected components' kernels. Throughput is recorded per
5-second window into a preallocated typed array. The drop over time is the stand-in for the
temperature reading the browser cannot give: a falling line means thermal throttling.

During Endurance and Stress the page may update at most once per second, and a
"no live updates" switch disables even that.

All modes:

- Request a screen Wake Lock for the run.
- If the tab becomes hidden, stop measuring and mark the affected samples invalid. Browsers
  throttle hidden tabs, so those numbers are wrong.
- Cancel is always available and always cleans up workers, GPU resources and OPFS files.

## 5. Measurement method

1. Create workers, instantiate WASM, allocate buffers. Not timed.
2. Warm-up run. Not recorded.
3. Timed samples. Each sample calls the kernel once and reads `performance.now()` before and
   after, **inside the worker**. Sizes are chosen so one sample runs at least 250 ms, which
   makes timer resolution irrelevant. Exception (M3 review): latency runs target about 50 ms
   or more at the fastest plausible latency (2,500+ ticks even at a 20 µs timer). Long
   samples on hybrid CPUs almost always contain a core move or clock change, so many shorter
   samples give cleaner fastest samples. Each latency size spins 150 ms first.
4. Adaptive sampling (changed in M1 after review; was a fixed 3 / 7 samples). Quick takes at
   least 3 samples and at most 9, Full at least 7 and at most 21. After the minimum, the worker
   stops once the fastest *minimum-count* samples agree within 5% (Quick) or 3% (Full), or
   after 3 s / 8 s of extra sampling. Results use those fastest samples: slow samples are
   mostly interference (another process, a slow core on hybrid CPUs, a clock dip). Report
   median, min, max and spread of them. A spread above 10% marks the row **noisy**.
5. No `postMessage`, no allocation and no logging inside a timed region. Results are posted
   once per kernel, after timing ends.
6. The page compiles the wasm module once and sends it to workers. Each worker busy-spins for
   0.5 s before its first kernel, so the OS moves it to a fast core and raises the clock.
7. If the tab is hidden at any point while a kernel runs, that kernel's result is discarded.

## 6. Scoring

- **Headline:** raw median per kernel in its real unit.
- **Reference column:** the same kernel's number for each machine in
  `src/lib/scoring/references.json`. The first entry is the owner's PC, captured at M8.
  More entries are added by hand later.
- **Points:** per component, `1000 × geometric mean(result / constant)` over that component's
  kernels. Constants live in `src/lib/scoring/constants.ts` and are frozen per `scoreVersion`.
  Total = geometric mean of the component points that were run. A total from a partial
  selection is labelled **partial**.
- Any change to a kernel or its size bumps `scoreVersion`. Results with different
  `scoreVersion` are never compared.

## 7. Overhead rules for everything that is not a benchmark

These are requirements, and the reviewer checks each one.

- Runtime dependencies: Svelte only. No UI kit, no chart library (draw charts on a canvas by
  hand), no state library, no router.
- JS + CSS budget: 50 kB gzipped, excluding `.wasm`. Enforced by a script in `npm run check`.
- Each component's worker and WASM load lazily, only when selected.
- No timers, `requestAnimationFrame`, observers or DOM writes while a Benchmark-mode
  measurement window is open. Progress is drawn between kernels.
- No network requests after the initial load. No analytics, no web fonts, no remote assets.
- System font stack. No images where CSS will do.
- Typed arrays are preallocated and transferred, not copied.
- A dev build shows a visible "dev build — scores not valid" banner. Real runs use
  `npm run build` + `npm run preview`.

## 8. Architecture

```
page (Svelte)                     workers                         wasm
┌───────────────┐  start/cancel  ┌──────────────────┐  call     ┌──────────┐
│ select → run  │ ─────────────▶ │ runner.worker.ts │ ────────▶ │ kernels  │
│ → results     │ ◀───────────── │ (one per core)   │ ◀──────── │ (Rust)   │
└───────────────┘  one result    └──────────────────┘ checksum  └──────────┘
        │          per kernel     gpu.worker.ts / storage.worker.ts
        ▼
  localStorage (history) ── JSON export / import
```

### Layout

```
browser-bench/
  docs/SPEC.md
  kernels/                 Rust crate, cdylib, wasm32-unknown-unknown, no deps
    src/{lib.rs,sha256.rs,lz.rs,sort.rs,nbody.rs,mandelbrot.rs,matmul.rs,fft.rs,trace.rs,mem.rs}
  src/
    lib/harness/           worker protocol, timing, stats, orchestrator
    lib/bench/{cpu,memory,gpu,storage}/
    lib/scoring/           constants.ts, references.json, score.ts
    lib/store/             history, export, import, schema versions
    lib/sysinfo/
    ui/                    Svelte components
    workers/
  tests/{unit,e2e}/
  public/_headers          COOP/COEP for static hosts
  vite.config.ts           sets COOP/COEP on dev and preview, binds 127.0.0.1
```

### Headers

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Set in `vite.config.ts` for `server` and `preview`. The app checks `crossOriginIsolated` on
load and shows a blocking explanation if it is false. Hosting later needs a host that can send
these headers (Cloudflare Pages and Netlify can; GitHub Pages cannot without a workaround).

### Commands

```
npm run dev        dev server on 127.0.0.1
npm run build      cargo build (wasm) + vite build
npm run preview    serve the production build on 127.0.0.1
npm run check      typecheck + lint + unit tests + size budget
npm run e2e        Playwright against the preview server
```

## 9. Testing

| Layer | Tool | What it proves |
|---|---|---|
| Kernel correctness | Vitest loading the built `.wasm` in Node | each kernel returns its known checksum at `smoke` and one real size |
| Logic | Vitest | stats, scoring math, store schema, import/export round trip |
| End to end | Playwright, Chrome channel | page is cross-origin isolated; a `smoke` run of every component completes, checksums pass, results render, history persists, cancel cleans up |
| Overhead | script in `npm run check` | bundle budget; no network after load (asserted in e2e) |

Kernel tests run against the `.wasm` rather than as native `cargo test` binaries on purpose
(risk R1). GPU e2e may be unavailable in headless Chrome; in that case the test is reported as
**skipped**, never as passed.

Tests never assert on speed. Speed varies by machine; only correctness and structure are
asserted.

## 10. Toolchain

| Tool | State on the owner's PC (2026-11-13) | Needed |
|---|---|---|
| Node 26, npm 12 | installed | yes |
| git | installed | yes |
| Rust (`rustup`, `cargo`) | **missing** | install, then `rustup target add wasm32-unknown-unknown` |
| Playwright Chrome | missing | `npx playwright install chrome` at M0 |

`wasm-opt` is optional and may be added later if it measurably helps.

## 11. Agents

| Role | Model | May edit | Job |
|---|---|---|---|
| Builder | Opus 5.5 | `src/`, `kernels/`, config | implement one milestone |
| Reviewer | Opus 5.5, fresh context | nothing | read the diff against this spec and section 7; return findings |
| Tester | Sonnet 5.5 | `tests/` only | write and run tests; report real output |

Loop per milestone: Builder → Reviewer → Builder fixes → Tester → Builder fixes. At most three
fix rounds, then stop and ask the owner. Nobody marks a milestone done while `npm run check`
or `npm run e2e` fails. A skipped test is reported as skipped.

M2–M5 touch separate directories and can be built by parallel Builders once M1 is merged. Each
parallel Builder owns only its own `src/lib/bench/<component>/` and kernel files.

## 12. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Scaffold: Vite + Svelte + TS, Rust crate, headers, scripts, one trivial kernel wired end to end | `npm run check` and `npm run e2e` pass; page reports `crossOriginIsolated === true` |
| M1 | Harness (protocol, timing, stats, orchestrator), selection UI, CPU single-core kernels | all CPU kernels pass checksums; Quick run shows raw results |
| M2 | CPU all-cores | scaling ratio shown; worker count adjustable |
| M3 | Memory tests | latency curve drawn; allocation failure handled |
| M4 | GPU tests, WebGL2 fallback | WebGPU results on the owner's PC; fallback labelled |
| M5 | Storage tests | files always cleaned up, including on cancel |
| M6 | Scoring, reference column, history, export/import | round trip preserves results; `scoreVersion` enforced |
| M7 | Endurance and Stress modes, chart, tab-hidden handling, Wake Lock | 10-min Endurance completes with drop % reported |
| M8 | Polish, size budget, capture owner's PC as first reference | budget met; `references.json` has one real entry |

## 13. Risks

| # | Risk | Plan |
|---|---|---|
| R1 | Windows Smart App Control blocks freshly compiled unsigned binaries (it already blocks numpy's on this PC). Cargo build scripts and native test executables are such binaries. | D2 removes build scripts and proc-macros; tests run against `.wasm` in Node. If `rustc` itself is blocked, build the kernels inside WSL2 and keep the repo on Windows. |
| R2 | Headless Chrome lacks WebGPU | Report GPU e2e as skipped; verify GPU by hand on the owner's PC at M4. |
| R3 | Browser updates shift scores | Browser version stored with every result and shown next to it. |
| R4 | Storage numbers mislead (OS cache, browser layer) | Shown raw, with the caveat stated on the results page. |
| R5 | Timer coarsening if isolation is lost | Blocking check on load (section 8). |

## 14. Open items for later

- Hosting target and domain.
- Firefox and Safari support.
- More reference machines.
- Online result sharing.
