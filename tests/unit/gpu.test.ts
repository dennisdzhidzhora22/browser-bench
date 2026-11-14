// GPU tests that need no GPU: def structure, the GPU plan (with a faked browser), the ray-march
// JS mirror, and how the orchestrator turns a GPU result into an outcome.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { components } from '../../src/lib/bench/components.ts';
import {
  fallbackKernels,
  gpuFactories,
  gpuKernels,
  isFallback,
  planGpus,
  webgpuKernels,
  type GpuChoice,
} from '../../src/lib/bench/gpu/index.ts';
import { createGpuMatmul, gpuMatmul } from '../../src/lib/bench/gpu/matmul.ts';
import {
  checkFragmentImage,
  FRAGMENT_TOLERANCE,
  fragmentHeight,
  fragmentWork,
  MARCH_STEPS,
  pickPixels,
  shadeMirror,
} from '../../src/lib/bench/gpu/raymarch.ts';
import { GPU_TARGET_MS, GPU_VALID } from '../../src/lib/bench/gpu/types.ts';
import { defKey, type SizeId } from '../../src/lib/bench/types.ts';
import { resultToOutcome } from '../../src/lib/harness/orchestrator.ts';
import type { RunResult } from '../../src/lib/harness/protocol.ts';

const SIZES: SizeId[] = ['smoke', 'standard'];

describe('GPU defs', () => {
  it('there are four WebGPU tests and one WebGL2 fallback, in a fixed order', () => {
    expect(webgpuKernels.map((d) => d.id)).toEqual(['gpu_nbody', 'gpu_matmul', 'gpu_draws', 'gpu_fragment']);
    expect(fallbackKernels.map((d) => d.id)).toEqual(['gpu_fragment_gl']);
    expect(gpuKernels).toEqual([...webgpuKernels, ...fallbackKernels]);
  });

  it('the GPU component lists exactly the GPU defs (it is selectable)', () => {
    const gpu = components.find((c) => c.id === 'gpu')!;
    expect(gpu.kernels).toBe(gpuKernels);
    expect(gpu.kernels.length).toBeGreaterThan(0);
  });

  it.each(gpuKernels.map((d) => [d.id, d] as const))('%s: validated-output contract', (_id, d) => {
    for (const s of SIZES) {
      // GPU floats are not bit-exact: the worker reports 1 (valid) or 0, so expected is 1 everywhere.
      expect(d.expected[s], `${d.id} expected.${s}`).toBe(GPU_VALID);
    }
    expect(GPU_VALID).toBe(1);
    expect(d.targetMs).toBe(GPU_TARGET_MS);
    expect(GPU_TARGET_MS).toBeGreaterThan(0);
    expect(d.seed).toBeGreaterThan(0);
    expect(d.unit.length).toBeGreaterThan(0);
    expect(d.name.length).toBeGreaterThan(0);
  });

  it.each(gpuKernels.map((d) => [d.id, d] as const))('%s: sizes and work are positive', (_id, d) => {
    for (const s of SIZES) {
      expect(Number.isInteger(d.sizes[s]), `${d.id} sizes.${s}`).toBe(true);
      expect(d.sizes[s]).toBeGreaterThan(0);
      const w = d.work(d.sizes[s]);
      expect(Number.isFinite(w), `${d.id} work(${s})`).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
    expect(d.sizes.smoke).toBeLessThan(d.sizes.standard);
    expect(d.work(d.sizes.smoke)).toBeLessThan(d.work(d.sizes.standard));
  });

  it('keys are unique and non-empty', () => {
    const keys = gpuKernels.map(defKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.length).toBeGreaterThan(0);
    expect(new Set(gpuKernels.map((d) => d.id)).size).toBe(gpuKernels.length);
  });

  it('every def has a factory and every factory belongs to a def', () => {
    expect(Object.keys(gpuFactories).sort()).toEqual(gpuKernels.map((d) => d.id).sort());
    for (const d of gpuKernels) expect(typeof gpuFactories[d.id], d.id).toBe('function');
  });

  it('factories return a fresh kernel with the four GpuKernel methods', () => {
    for (const d of gpuKernels) {
      const a = gpuFactories[d.id]!();
      const b = gpuFactories[d.id]!();
      expect(a, d.id).not.toBe(b);
      for (const m of ['prepare', 'runBatch', 'validate', 'dispose'] as const) {
        expect(typeof a[m], `${d.id}.${m}`).toBe('function');
      }
    }
  });

  it('dispose before prepare does not throw', () => {
    for (const d of gpuKernels) expect(() => gpuFactories[d.id]!().dispose(), d.id).not.toThrow();
  });

  it('isFallback is true only for the WebGL2 test', () => {
    for (const d of webgpuKernels) expect(isFallback(d), d.id).toBe(false);
    for (const d of fallbackKernels) expect(isFallback(d), d.id).toBe(true);
  });

  it('known work formulas', () => {
    const by = (id: string) => gpuKernels.find((d) => d.id === id)!;
    expect(by('gpu_nbody').work(1000)).toBe(1e6 / 1e9); // n^2 interactions
    expect(by('gpu_matmul').work(2048)).toBeCloseTo((2 * 2048 ** 3) / 1e9, 9);
    expect(by('gpu_draws').work(10_000)).toBe(10); // K draws
    expect(by('gpu_fragment').work(1920)).toBeCloseTo((1920 * 1080) / 1e6, 9);
    expect(by('gpu_fragment_gl').work(1920)).toBe(by('gpu_fragment').work(1920));
  });
});

describe('gpu_matmul size rule (n is a multiple of 64)', () => {
  it('its smoke and standard sizes are multiples of 64', () => {
    for (const s of SIZES) {
      expect(gpuMatmul.sizes[s] % 64, s).toBe(0);
      expect(gpuMatmul.sizes[s]).toBeGreaterThanOrEqual(64);
    }
  });

  it.each([0, 1, 63, 65, 100, 96, 2047, 64.5, -64, Number.NaN])('prepare rejects n = %s before touching the GPU', async (n) => {
    const k = createGpuMatmul();
    // Only the size check can run: the fake device has no limits, so reaching them would TypeError.
    await expect(k.prepare({ device: {} as GPUDevice }, 1, n)).rejects.toThrow(/multiple of 64/);
    k.dispose();
  });

  it('prepare without a device fails with a clear message', async () => {
    await expect(createGpuMatmul().prepare({}, 1, 64)).rejects.toThrow(/gpu_matmul.*device/);
  });
});

describe('fragment sizes', () => {
  it('height is width * 9 / 16, rounded, at least 1', () => {
    expect(fragmentHeight(64)).toBe(36);
    expect(fragmentHeight(1920)).toBe(1080);
    expect(fragmentHeight(1)).toBe(1);
    expect(fragmentHeight(16)).toBe(9);
  });

  it('work is megapixels per frame', () => {
    expect(fragmentWork(1920)).toBeCloseTo(2.0736, 9);
    expect(fragmentWork(64)).toBeCloseTo((64 * 36) / 1e6, 12);
  });
});

describe('ray-march JS mirror', () => {
  const W = 64;
  const H = fragmentHeight(W);

  it('is deterministic', () => {
    for (const [x, y] of [
      [0.5, 0.5],
      [32.5, 18.5],
      [10.5, 30.5],
      [63.5, 35.5],
    ] as const) {
      expect(shadeMirror(x, y, W, H)).toEqual(shadeMirror(x, y, W, H));
    }
    expect(pickPixels(W, H)).toEqual(pickPixels(W, H));
    expect(pickPixels(1920, 1080)).toEqual(pickPixels(1920, 1080));
  });

  it('returns colours in 0..255 and a sane material and step count', () => {
    for (let y = 0.5; y < H; y += 5) {
      for (let x = 0.5; x < W; x += 5) {
        const p = shadeMirror(x, y, W, H);
        for (const c of p.rgb) {
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
        }
        expect([-1, 0, 1, 2, 3]).toContain(p.mat);
        expect(p.steps).toBeGreaterThanOrEqual(0);
        expect(p.steps).toBeLessThanOrEqual(MARCH_STEPS);
      }
    }
  });

  it('the top of the frame is sky and the bottom hits the ground plane (material 0)', () => {
    expect(shadeMirror(W / 2, 0.5, W, H).mat).toBe(-1);
    expect(shadeMirror(W / 2, H - 0.5, W, H).mat).toBe(0);
  });

  it('the scene contains every material at a larger size (blob, box, torus, ground)', () => {
    const seen = new Set<number>();
    for (let y = 0.5; y < 108; y += 3) for (let x = 0.5; x < 192; x += 3) seen.add(shadeMirror(x, y, 192, 108).mat);
    expect([...seen].sort()).toEqual([-1, 0, 1, 2, 3]);
  });

  it('picks 4..8 in-bounds pixels with distinct coordinates, same at both sizes', () => {
    for (const [w, h] of [
      [W, H],
      [1920, 1080],
    ] as const) {
      const picked = pickPixels(w, h);
      expect(picked.length).toBeGreaterThanOrEqual(4);
      expect(picked.length).toBeLessThanOrEqual(8);
      const seen = new Set<string>();
      for (const p of picked) {
        expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(w);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThan(h);
        seen.add(`${p.x},${p.y}`);
        // The expected colour is the mirror's own colour at the pixel centre.
        expect(p.rgb).toEqual(shadeMirror(p.x + 0.5, p.y + 0.5, w, h).rgb);
      }
      expect(seen.size).toBe(picked.length);
    }
  });

  it('every picked pixel is in a smooth region: same material and colour within 4 steps 1/4 pixel away', () => {
    for (const [w, h] of [
      [W, H],
      [1920, 1080],
    ] as const) {
      for (const p of pickPixels(w, h)) {
        const c = shadeMirror(p.x + 0.5, p.y + 0.5, w, h);
        for (const [dx, dy] of [
          [0.25, 0],
          [-0.25, 0],
          [0, 0.25],
          [0, -0.25],
        ] as const) {
          const n = shadeMirror(p.x + 0.5 + dx, p.y + 0.5 + dy, w, h);
          expect(n.mat).toBe(c.mat);
          for (let k = 0; k < 3; k++) expect(Math.abs(n.rgb[k]! - c.rgb[k]!)).toBeLessThanOrEqual(4);
        }
        // Far from the march limit, so f32 rounding cannot change the outcome.
        if (c.mat >= 0) expect(c.steps).toBeLessThanOrEqual((MARCH_STEPS * 2) / 3);
        else expect(c.steps).toBeLessThan(MARCH_STEPS);
      }
    }
  });

  it('picks mostly object/ground pixels with at most two sky pixels when enough hits exist', () => {
    const picked = pickPixels(1920, 1080);
    const sky = picked.filter((p) => shadeMirror(p.x + 0.5, p.y + 0.5, 1920, 1080).mat < 0);
    expect(picked.length).toBe(8);
    expect(sky.length).toBeLessThanOrEqual(2);
    expect(picked.length - sky.length).toBeGreaterThanOrEqual(6);
  });

  // The check pixels are part of the test's definition: if they move, results across versions are no longer
  // comparable. Pinned from the current mirror; update deliberately with an ABI/doc note.
  it('picked pixel coordinates are pinned (stable across runs and versions)', () => {
    expect(pickPixels(64, 36).map((p) => [p.x, p.y])).toEqual([
      [30, 10],
      [42, 14],
      [50, 18],
      [26, 26],
      [22, 30],
      [26, 34],
      [30, 2],
      [34, 6],
    ]);
    expect(pickPixels(1920, 1080).map((p) => [p.x, p.y])).toEqual([
      [1260, 300],
      [1860, 420],
      [180, 660],
      [420, 780],
      [660, 900],
      [900, 1020],
      [900, 60],
      [1020, 180],
    ]);
  });
});

describe('checkFragmentImage', () => {
  const W = 64;
  const H = 36;
  /** A full RGBA image of the mirror's pixel centres, top-left origin. */
  function mirrorImage(): Uint8Array {
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = shadeMirror(x + 0.5, y + 0.5, W, H).rgb;
        const o = (y * W + x) * 4;
        px[o] = Math.round(c[0]);
        px[o + 1] = Math.round(c[1]);
        px[o + 2] = Math.round(c[2]);
        px[o + 3] = 255;
      }
    }
    return px;
  }
  const offset = (x: number, y: number): number => (y * W + x) * 4;

  it('accepts an image equal to the mirror', () => {
    expect(checkFragmentImage(W, H, mirrorImage(), offset)).toEqual({ ok: true });
  });

  it('accepts an error within the tolerance and rejects one just beyond it', () => {
    const p = pickPixels(W, H)[0]!;
    const within = mirrorImage();
    within[offset(p.x, p.y)]! += FRAGMENT_TOLERANCE;
    expect(checkFragmentImage(W, H, within, offset).ok).toBe(true);
    const beyond = mirrorImage();
    beyond[offset(p.x, p.y)]! += FRAGMENT_TOLERANCE + 1;
    const r = checkFragmentImage(W, H, beyond, offset);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(new RegExp(`pixel \\(${p.x},${p.y}\\)`));
  });

  it('rejects a black image, a uniform image and a flipped image', () => {
    expect(checkFragmentImage(W, H, new Uint8Array(W * H * 4), offset).ok).toBe(false);
    const grey = new Uint8Array(W * H * 4).fill(128);
    expect(checkFragmentImage(W, H, grey, offset).ok).toBe(false);
    // Bottom-left origin read with the top-left offset: the wrong orientation must not pass.
    const flipped = checkFragmentImage(W, H, mirrorImage(), (x, y) => ((H - 1 - y) * W + x) * 4);
    expect(flipped.ok).toBe(false);
  });
});

describe('planGpus (faked browser)', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Info = { vendor?: string; architecture?: string; device?: string; description?: string };
  type Pref = 'high-performance' | 'low-power';

  /** navigator.gpu whose adapter depends on the requested preference. */
  function fakeWebGpu(byPref: Record<Pref, Info | null>, calls: Pref[] = []): void {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async (o: { powerPreference: Pref }) => {
          calls.push(o.powerPreference);
          const info = byPref[o.powerPreference];
          return info ? { info } : null;
        },
      },
    });
  }

  /** OffscreenCanvas whose webgl2 context reports a renderer per preference (null = no WebGL2). */
  function fakeWebGl2(byPref: Record<Pref, string | null>): void {
    class FakeCanvas {
      getContext(kind: string, opts?: { powerPreference?: Pref }) {
        if (kind !== 'webgl2') return null;
        const label = byPref[opts?.powerPreference ?? 'high-performance'];
        if (label === null) return null;
        return {
          RENDERER: 1,
          getExtension: (n: string) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 2 } : null),
          getParameter: (p: number) => (p === 2 ? label : 'masked'),
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  }

  const nvidia: Info = { vendor: 'nvidia', architecture: 'ada', device: '2684', description: 'RTX 4090' };
  const intel: Info = { vendor: 'intel', architecture: 'xe', device: '46a6', description: '' };

  it('webgpu, fast: one target, label built from the adapter info, no same-GPU hint', async () => {
    const calls: Pref[] = [];
    fakeWebGpu({ 'high-performance': nvidia, 'low-power': intel }, calls);
    const plan = await planGpus('high-performance');
    expect(plan).toEqual({
      api: 'webgpu',
      targets: [{ preference: 'high-performance', label: 'nvidia · ada · 2684 · RTX 4090' }],
      sameGpu: false,
    });
    expect(calls).toEqual(['high-performance']);
  });

  it('webgpu, power-saving: asks only for low-power, drops empty info fields', async () => {
    const calls: Pref[] = [];
    fakeWebGpu({ 'high-performance': nvidia, 'low-power': intel }, calls);
    const plan = await planGpus('low-power');
    expect(plan.targets).toEqual([{ preference: 'low-power', label: 'intel · xe · 46a6' }]);
    expect(plan.sameGpu).toBe(false);
    expect(calls).toEqual(['low-power']);
  });

  it('webgpu, both, two different GPUs: two targets in run order, no hint', async () => {
    fakeWebGpu({ 'high-performance': nvidia, 'low-power': intel });
    const plan = await planGpus('both');
    expect(plan.api).toBe('webgpu');
    expect(plan.targets.map((t) => t.preference)).toEqual(['high-performance', 'low-power']);
    expect(new Set(plan.targets.map((t) => t.label)).size).toBe(2);
    expect(plan.sameGpu).toBe(false);
  });

  it('webgpu, both, same GPU: tested once (as high-performance) and sameGpu is set', async () => {
    fakeWebGpu({ 'high-performance': nvidia, 'low-power': nvidia });
    const plan = await planGpus('both');
    expect(plan.api).toBe('webgpu');
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.preference).toBe('high-performance');
    expect(plan.sameGpu).toBe(true);
  });

  it('an adapter with no info is labelled "GPU"', async () => {
    fakeWebGpu({ 'high-performance': {}, 'low-power': {} });
    expect((await planGpus('high-performance')).targets[0]!.label).toBe('GPU');
  });

  it.each<GpuChoice>(['high-performance', 'low-power'])('a single choice (%s) never sets sameGpu', async (choice) => {
    fakeWebGpu({ 'high-performance': nvidia, 'low-power': nvidia });
    expect((await planGpus(choice)).sameGpu).toBe(false);
  });

  it('no adapter: falls back to WebGL2 and labels it from the renderer string', async () => {
    fakeWebGpu({ 'high-performance': null, 'low-power': null });
    fakeWebGl2({ 'high-performance': 'ANGLE (NVIDIA)', 'low-power': 'ANGLE (Intel)' });
    expect(await planGpus('both')).toEqual({
      api: 'webgl2',
      targets: [
        { preference: 'high-performance', label: 'ANGLE (NVIDIA)' },
        { preference: 'low-power', label: 'ANGLE (Intel)' },
      ],
      sameGpu: false,
    });
  });

  it('requestAdapter throwing falls back to WebGL2 instead of failing the plan', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => {
          throw new Error('boom');
        },
      },
    });
    fakeWebGl2({ 'high-performance': 'R', 'low-power': 'R' });
    const plan = await planGpus('both');
    expect(plan.api).toBe('webgl2');
    expect(plan.targets).toEqual([{ preference: 'high-performance', label: 'R' }]);
    expect(plan.sameGpu).toBe(true);
  });

  it('no navigator.gpu at all: WebGL2', async () => {
    vi.stubGlobal('navigator', {});
    fakeWebGl2({ 'high-performance': 'R', 'low-power': 'R' });
    const plan = await planGpus('low-power');
    expect(plan).toEqual({ api: 'webgl2', targets: [{ preference: 'low-power', label: 'R' }], sameGpu: false });
  });

  it('neither API: api is none with no targets', async () => {
    vi.stubGlobal('navigator', {});
    fakeWebGl2({ 'high-performance': null, 'low-power': null });
    for (const choice of ['high-performance', 'low-power', 'both'] as const) {
      expect(await planGpus(choice)).toEqual({ api: 'none', targets: [], sameGpu: false });
    }
  });

  it('OffscreenCanvas missing or throwing is treated as no WebGL2, not an exception', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect((await planGpus('both')).api).toBe('none');
  });
});

describe('resultToOutcome for GPU results', () => {
  const nbody = gpuKernels.find((d) => d.id === 'gpu_nbody')!;
  const res = (over: Partial<RunResult> = {}): RunResult => ({
    type: 'result',
    id: 0,
    kernel: 'gpu_nbody',
    checksum: 1,
    checksumConsistent: true,
    prepareMs: 1,
    times: Float64Array.of(100, 100, 100),
    ...over,
  });

  it.each(SIZES)('checksum 1 is valid at %s size', (s) => {
    for (const d of gpuKernels) {
      const o = resultToOutcome(d, d.sizes[s], s, 'quick', res());
      expect(o.checksumOk, d.id).toBe(true);
      expect(o.valid, d.id).toBe(true);
      expect(o.error, d.id).toBeUndefined();
    }
  });

  it('checksum 0 is invalid, and the worker detail goes into the error text', () => {
    const o = resultToOutcome(nbody, nbody.sizes.smoke, 'smoke', 'quick', res({ checksum: 0, detail: 'body 3 off by 12%' }));
    expect(o.checksumOk).toBe(false);
    expect(o.valid).toBe(false);
    expect(o.error).toBe('output check failed: body 3 off by 12%');
  });

  it('checksum 0 without a detail uses the generic message', () => {
    const o = resultToOutcome(nbody, nbody.sizes.standard, 'standard', 'quick', res({ checksum: 0 }));
    expect(o.valid).toBe(false);
    expect(o.error).toMatch(/checksum mismatch/);
  });

  it('only exactly 1 counts as valid', () => {
    for (const bad of [2, 0xffffffff, 1.5]) {
      expect(resultToOutcome(nbody, 256, 'smoke', 'quick', res({ checksum: bad })).checksumOk, String(bad)).toBe(false);
    }
  });

  it('a detail is ignored when the output check passed', () => {
    const o = resultToOutcome(nbody, 256, 'smoke', 'quick', res({ detail: 'stale' }));
    expect(o.valid).toBe(true);
    expect(o.error).toBeUndefined();
  });

  it('throughput scales with reps: work * reps / median seconds', () => {
    // median 100 ms, work(256) = 256^2 / 1e9
    const one = resultToOutcome(nbody, 256, 'smoke', 'quick', res({ reps: 1 }));
    const many = resultToOutcome(nbody, 256, 'smoke', 'quick', res({ reps: 50 }));
    const absent = resultToOutcome(nbody, 256, 'smoke', 'quick', res());
    expect(one.throughput).toBeCloseTo((nbody.work(256) * 1) / 0.1, 12);
    expect(many.throughput).toBeCloseTo((nbody.work(256) * 50) / 0.1, 12);
    expect(absent.throughput).toBe(one.throughput);
  });

  it('a hidden tab discards a valid GPU result', () => {
    const o = resultToOutcome(nbody, 256, 'smoke', 'quick', res(), true);
    expect(o.checksumOk).toBe(true);
    expect(o.valid).toBe(false);
    expect(o.hidden).toBe(true);
    expect(o.error).toMatch(/hidden/);
  });
});
