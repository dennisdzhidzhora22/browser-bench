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
gets its own results table, labelled with what the browser reports. Scoring (M6): each
tested GPU gets its own GPU points. When several GPUs were tested ("Both"), only the **Fast**
(`high-performance`) one counts in the total; a single tested GPU always counts, whichever
preference the user picked. "Same GPU" is reported only when both preferences found an
adapter.

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

How it works (M5): storage tests run in `storage.worker.ts` on one file of 256 MiB (smoke:
2 MiB), scaled down to a quarter of the quota left; below 16 MiB the page reports low quota.
256 MiB keeps a Quick run of all four tests to about 15 s; a file large enough to defeat the
OS cache would have to exceed RAM, so reads are cache-assisted by design (R4). Each test
repeats its work to fill about 250 ms per sample (calibrated once). Sequential tests move
1 MiB chunks, one pass per repetition; random tests do 256 block-aligned 4 KiB operations
per repetition at seeded offsets; both write tests `flush()` once per repetition. Every 4 KiB
block carries its own index and a write-pass number, so instead of checksums each test checks
after timing what it read (buffers are cleared before each sample) or reads back what it
wrote. Each run's files live in one directory named `bb-storage-…`. The page deletes it after
every run, including errors and cancel (`Worker.terminate()`), retrying for up to 15 s while
the terminated worker's file lock clears (measured up to about 3 s), and sweeps leftover
directories at page load and before each storage run (awaited, so never during a
measurement). Each run holds a Web Lock named after its directory for its whole life,
cleanup included; the sweep removes only directories whose lock is free, so it never touches
a live run in another tab. Random 4 KiB results mostly measure the browser's per-call cost,
not the drive. M6: storage results with different file sizes (`def.sizes`) must not be
compared with each other or with references.

### 3.6 System info (not scored)

User agent, browser version, logical core count, `deviceMemory` (coarse), GPU adapter info,
screen size, measured refresh rate, `crossOriginIsolated`. Collected once before a run.

How it works (M6): `lib/sysinfo` reads brand and full version from
`navigator.userAgentData.getHighEntropyValues(['fullVersionList'])` (skipping GREASE brands and
preferring the product over "Chromium"), else parses the UA string. Screen is CSS pixels and
device pixel ratio. GPU info is what the GPU worker reports for each tested GPU. **Refresh rate
is not measured:** no result depends on it (GPU tests render off-screen), and measuring it
would add about half a second of `requestAnimationFrame` counting before every run.

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

How it works (M7):

- **Parts.** Each selected component is one *part* with its own workers, and **all parts run
  at the same time** (CPU all-cores next to the GPU is the real stress case). CPU single core:
  1 worker; CPU all cores: the worker count; Memory: the all-cores copy (`mem_copy_mt`) on the
  worker count; GPU: one GPU worker on the first planned GPU (with "Both", the Fast one).
  **Storage is not looped** (it would wear the drive for no thermal insight); the page says
  so and keeps M5's guarantees by never creating files in these modes. CPU parts use the
  `multi` sizes (short runs, under ~16 MB per instance). Selecting CPU all cores and Memory
  together runs two workers per core: deliberate oversubscription, fine for drop % because
  each part is compared with its own start.
- **Loop.** One `loop` message per worker (`protocol.ts`, `LoopRequest`). Windows are 5 s on
  the shared absolute clock (`timeOrigin + now`), starting 3 s after every worker is ready
  (CPU workers warm up each kernel for 150 ms, checking its checksum, and GPU workers prepare
  and calibrate every test in that time; without the warm-up the first window ran at about half
  speed and made a wrong 100 %). Each window is split into equal
  slices, one per kernel, so all workers of a part run the same kernel at the same time with
  no barrier. A CPU slice prepares its kernel (untimed; the arena holds one kernel at a time)
  and calls `run` until the slice ends, checking every checksum (a mismatch fails the part); a
  GPU slice submits whole calibrated batches (~200 ms) and its outputs are validated once
  after the loop, also after Stop. The worker writes `reps / ms` per kernel per window into a
  preallocated `Float64Array` on a `SharedArrayBuffer` (NaN = not measured) and a finished-
  window counter; nothing is posted until the loop ends. A worker that reaches a slice or
  window late (a slow call, a paused tab) leaves it NaN and catches up on the clock.
- **Series.** Window w counts once every worker of the part has finished it. A kernel's rate is
  the sum over workers; the window's value is `geomean over kernels of rate / base`, where the
  base is each kernel's rate in the first window in which every kernel was measured and the
  tab was visible (that window = 100 %). The first window's absolute throughput per kernel is
  shown and saved.
- **Drop.** `drop = 1 − mean(last n valid windows) / mean(first n valid windows)` with
  `n = min(12, floor(valid / 2))`: the first and last minute of valid windows, or halves of a
  shorter run. Fewer than 2 valid windows: no drop. Positive = slower at the end.
- **Hidden tab.** Workers keep the load running (so the thermal state carries on), but any
  window overlapping a hidden period is invalid: excluded from the base and the drop, shown
  as a grey band on the chart, and its index saved.
- **Page.** At most one update per second (a 1 s interval reads the shared arrays and redraws
  the chart and the clock); "No live updates" skips even that until the run ends. The engine
  and the chart load lazily, on first use, outside the page-load budget. The chart is a
  hand-drawn canvas: one line per part, y = % of the start, x = minutes.
- **Endings.** Endurance ends after 10, 30 or 60 min (test only: `?endurance=30s` or `=1m`).
  Cancel terminates every worker at once (after setting each loop's STOP flag). Stress runs
  until Stop (capped at 12 h, which bounds the preallocated arrays): Stop sets STOP, waits up
  to 3 s for workers to finish their slice and GPU validation, then terminates everything,
  like Cancel. Stress results are shown, not saved.
- **Wake Lock** (all modes): `navigator.wakeLock.request('screen')` at the start, requested
  again when the tab becomes visible (browsers release it when hidden), released at the end or
  on cancel. Unsupported or refused: the run goes on; Endurance and Stress say the screen may
  sleep. Benchmark mode shows nothing about it, so a re-acquire never writes to the DOM
  mid-test.
- **Record.** A finished Endurance run is saved (`mode: "endurance"`, no components, so no
  points) with an `endurance` block: planned `durationMs`, `windowMs`, hidden window indexes,
  and per part its id, label, workers, kernel keys and units, first-window throughput (6
  significant digits) and the window series (4 significant digits, null = invalid). A 60-minute
  run is about 5 kB per part. Import validates it strictly (equal list lengths, at most 1,000
  windows, values ≥ 0 or null; `mode: "endurance"` if and only if the block is present) and
  recomputes every drop from the series: saved drops are never trusted. `schema` stays 1:
  the block is optional, so older records still load.

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

How it works (M6):

- **Record.** Each finished run (not cancelled or failed) becomes one `RunRecord`
  (`lib/store/schema.ts`, format `schema: 1`): run id (UUID), UTC timestamp, mode, size id,
  `scoreVersion`, system info (3.6), and one entry per component run. GPU has one entry per
  tested GPU (preference, label, API, adapter info); storage records the file size used and
  whether it was scaled. Each kernel entry holds its key (`defKey`), unit, headline value
  (null when invalid), sample-time median/min/max in ms, spread, samples taken, valid / noisy /
  hidden flags and error; all-cores entries add worker count, 1-worker value, scaling and the
  weak-baseline flag, and the 1-worker sample count. No per-sample arrays; numbers keep 6 significant digits. A full run is
  about 11 kB of JSON. Memory latency is stored as **ns per access** (unit `ns`).
- **Constants.** `lib/scoring/constants.ts`: `SCORE_VERSION = 1` and one constant per
  `<component>/<defKey>` (e.g. `cpu-multi/sha256`, `memory/mem_latency:16384`), in the
  record's unit. The M6 constants are **provisional**: rounded medians of one Quick run on the
  development PC. M8 refreezes them from the owner's PC.
- **Points.** Each kernel gives a ratio `value / constant` (`constant / value` for units
  where smaller is better, `ns`). Variants of one kernel first combine into one sub-score by
  their geomean: the 17 latency sizes are **one** sub-score (owner decision, 2026-11-15), so
  memory points = `1000 × geomean(fill, copy, copy_mt, latency)`. Every other component has
  one sub-score per kernel: points = `1000 × geomean(ratios)`. All-cores CPU scores the
  combined (all workers) throughput. A component is **partial** when one of its scored
  kernels (the component's defs, not the constants table) is invalid, hidden, missing or has
  no constant. Total = geomean of the counted component points; **partial** unless all five
  components ran with points and none is partial.
- **No points, and never compared with references:** smoke-size runs ("smoke: no points"),
  the WebGL2 fallback, a software GPU adapter, storage with a scaled-down file, and all-cores
  CPU when the worker count is not the core count ("N workers, not cores: no points"). For
  memory, an all-cores copy on another worker count is left out of the points (the component
  is partial) and gets no reference value. Hidden and invalid results never count.
- **Reference cells compare like with like:** a partial component's points, and a partial
  total, show "—" in the reference columns.
- **Saved points are never trusted.** On load and import, every record of this build's
  `scoreVersion` has its points, partial flags and total recomputed from its kernels. Each
  record is rebuilt from its known fields only (unknown keys are dropped); `time` must be ISO
  8601 UTC (`…Z`), core and worker counts integers ≥ 1, and a kernel cannot be both valid and
  hidden.
- **References.** `lib/scoring/references.json`: `[{ name, scoreVersion, results: { "<component>/<defKey>": value }, points: { "<component>": n, total: n } }]`.
  Empty until M8. The results tables show one extra column per entry whose `scoreVersion`
  matches this build's; with none, the column is hidden. Excluded components get no column.
- **History.** `lib/store/history.ts` keeps up to 50 runs in `localStorage` under
  `browser-bench:history` (the export format, compact), newest first. Smoke runs are saved
  and marked. Saving happens after the last measurement. A full quota or blocked storage shows
  a message; unreadable saved data shows a message and is replaced by the next save. The
  History section lists date, mode, browser and version, total (or "partial", "smoke: no
  points", "not comparable (score vN)"); a run can be opened, exported or deleted, and all
  runs exported or cleared (clear asks once more).
- **Endurance records (M7):** see section 4. They carry no points and the History list shows
  their drop per part instead of a total.
- **Export / import.** A file is `{ format: "browser-bench", schema: 1, runs: [...] }`,
  downloaded through a Blob URL (no network). Import checks the format marker, the schema
  version (unknown version: a clear message) and every field's type; any bad run rejects the
  whole file with a message, and nothing throws into the UI. Files over 5 MB are refused
  before they are read. Runs already in history (same id) are skipped. When an import would
  push saved runs out at the 50-run cap, the page says how many and asks first (an in-page
  Import / Cancel step). Runs with another `scoreVersion` import but show "not comparable (score
  vN)": their saved points are shown as saved, and no reference column appears.

## 7. Overhead rules for everything that is not a benchmark

These are requirements, and the reviewer checks each one.

- Runtime dependencies: Svelte only. No UI kit, no chart library (draw charts on a canvas by
  hand), no state library, no router.
- JS + CSS budget (owner decision, 2026-11-15): what loads when the page opens
  (`index.html`, the JS and CSS it references, and every chunk they import statically) is at
  most 50 kB gzipped. Lazily loaded worker chunks are not in that total; the script lists them
  separately and each must stay under 20 kB gzipped. `.wasm` is excluded. Enforced by
  `scripts/check-size.mjs` in `npm run check`.
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
    lib/store/             history, export, import, schema versions, record (outcomes <-> record)
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
| M8 | Polish, size budget, capture owner's PC as first reference | budget met; `references.json` has one real entry; four skins switchable |

**M8 polish (owner decision, 2026-11-15).** One shared layout based on mockup D
(`docs/mockup-d.html`): top bar (Benchmark / History / About), system strip, numbered sections
(setup, score, per-component tables with a "vs. ref" bar, memory latency chart vs. reference,
recent runs). Four switchable skins over that layout (`docs/mockup-m8.html`): **A Clean**
(cards), **B Terminal** (monospace, green on black, sharp), **C Vivid** (a colour per component,
tinted cards), **D Minimal** (lines, big light numbers). Each skin has light and dark, following
the OS unless the user picks one. The choice is saved in localStorage and applied before first
paint (no flash). Skins are CSS only (custom properties + small overrides): system fonts, no
images, no web fonts, no libraries, no animation during a run; switching is disabled during a
run. Budget: about 7 kB gzip for layout and skins, keeping page load under 50 kB with M7's chart.

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
