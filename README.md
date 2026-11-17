# browser-bench

Benchmark and stress-test your PC from a browser tab, in the spirit of Geekbench and Cinebench.
Everything runs on your machine: no install, no account, no data sent anywhere.

## What it tests

| Component | Tests |
|---|---|
| **CPU · 1 core** | SHA-256, LZ compression, sorting, n-body, Mandelbrot, matrix multiply (incl. SIMD), FFT, path tracer |
| **CPU · all cores** | The same kernels on every core, with the scaling over one core |
| **Memory** | Fill and copy bandwidth, plus a latency curve from 16 KB to 256 MB (L1 → L2 → L3 → RAM) |
| **GPU** | WebGPU n-body, matrix multiply, draw calls and a ray-marched scene; WebGL2 fallback |
| **Storage** | Sequential and random 4 KiB read/write through the browser's private file system (OPFS) |

Pick any mix of components and a mode:

- **Quick** – a couple of minutes.
- **Full** – longer, steadier numbers.
- **Endurance** – 10, 30 or 60 minutes, with a live chart and how much speed drops over time.
- **Stress** – runs until you stop it.

## Results

- Raw numbers in real units (MB/s, GFLOP/s, ns, IOPS) come first.
- Points sit beside them. **1000 points = the reference PC** (the owner's laptop: 16-thread
  CPU, RTX 5070 Ti, Chrome 157).
- History is kept in your browser, and runs can be exported and imported as JSON.
- Four looks (Clean, Terminal, Vivid, Minimal), each in light and dark.

These are **browser scores**: your PC's speed *through this browser*. WebAssembly reaches
roughly 70–95 % of native speed, and results move with browser versions, so every run records
the browser and its version. For steady numbers, keep the window in front, plug in a laptop
and use the best-performance power mode.

## Browsers

Chrome and Edge on desktop. The page must be cross-origin isolated (COOP/COEP headers) to get
shared memory and fine timers; it says so and refuses to run otherwise. Firefox and Safari are
not supported yet.

## Run it locally

You need Node.js and Rust (with the `wasm32-unknown-unknown` target).

```sh
npm install
npm run build      # Rust kernels -> WebAssembly, then the Vite build
npm run preview    # open http://127.0.0.1:4173
```

`npm run dev` works for UI work, but dev-build scores are not valid.

## Hosting

Every push to `main` runs `npm run check` in GitHub Actions, then deploys `dist/` to a
Cloudflare Worker with static assets (`wrangler.jsonc`). `dist/_headers` sets the COOP/COEP
headers; the deploy fails if they are missing. Secrets: `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

## How it's built

- **Kernels:** Rust compiled to WebAssembly, no dependencies, no glue code in the timed path.
- **UI:** Svelte 5 + TypeScript + Vite. The page loads under 50 kB (gzip, excluding the .wasm).
- **Timing:** all measured work runs in Web Workers; the page does nothing while a test is
  timing. Every result is checked (checksums, or GPU/storage output compared with a CPU
  reference), so a wrong or skipped result can't score.

## Development

```sh
npm run check      # build, type check, Rust lint, unit tests, size budget
npm run e2e        # browser tests (Playwright, installed Chrome)
```

The full design, decisions and milestones are in [`docs/SPEC.md`](docs/SPEC.md). Working rules
for contributors and agents are in [`CLAUDE.md`](CLAUDE.md).
