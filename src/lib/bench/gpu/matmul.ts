// Matrix multiply compute test (docs/SPEC.md, 3.4).
//
// size = n. C = A * B for square row-major f32 matrices, inputs uniform in
// [0, 1) from the seed (so every C entry is a positive sum, no cancellation).
// Kernel: each workgroup of 16x16 invocations computes a 64x64 block of C;
// each invocation owns a 4x4 register block (rows ty*4.., columns tx*4..).
// K is walked in steps of 16: the workgroup stages a 64x16 slice of A
// (transposed, as vec4 of 4 rows) and a 16x64 slice of B (vec4 of 4 columns)
// in workgroup memory (8 KiB), then each invocation does 16 rank-1 updates of
// its 4x4 block. n must be a multiple of 64. One iteration = one dispatch;
// work = 2 n^3 flops.
//
// Validation: read back C and compare 32 seeded-random entries with CPU f64
// dot products of the same f32 inputs (see TOLERANCE).

import type { KernelDef } from '../types.ts';
import { GPU_TARGET_MS, GPU_VALID, type GpuContext, type GpuKernel } from './types.ts';
import { checkStorageSize, readBack, requireDevice, rng, scoped, Usage } from './webgpu.ts';

export const gpuMatmul: KernelDef = {
  id: 'gpu_matmul',
  name: 'Matrix multiply (compute, f32)',
  stresses: 'compute, shared memory',
  unit: 'GFLOP/s',
  seed: 1,
  sizes: { smoke: 64, standard: 2048 },
  expected: { smoke: GPU_VALID, standard: GPU_VALID },
  work: (n) => (2 * n * n * n) / 1e9,
  targetMs: GPU_TARGET_MS,
};

const NAME = 'gpu_matmul';
const BLOCK = 64;
const SAMPLES = 512;

/**
 * Relative tolerance per sampled entry. Each entry is a sum of n positive f32
 * products accumulated in f32, so the error is at most about n * 6e-8 of the
 * value (1.2e-4 at n = 2048) and typically sqrt(n) * 6e-8 (~3e-6); fused or
 * unfused multiply-add only moves it within that. A wrong index or a missing
 * tile changes an entry by percents (the entries' spread is ~2% at n = 2048).
 */
const TOLERANCE = 1e-3;

const SHADER = /* wgsl */ `
@group(0) @binding(0) var<uniform> n: u32;
@group(0) @binding(1) var<storage, read> A: array<f32>;
@group(0) @binding(2) var<storage, read> B: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> C: array<vec4f>;

var<workgroup> As: array<vec4f, 256>; // [k * 16 + ty]: A rows ty*4..ty*4+3 at column k
var<workgroup> Bs: array<vec4f, 256>; // [k * 16 + tx]: B row k, columns tx*4..tx*4+3

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u,
        @builtin(local_invocation_index) li: u32) {
  let r0 = wid.y * 64u;
  let c0 = wid.x * 64u;
  let n4 = n / 4u;
  let la = li % 16u; // A slice: k
  let lr = li / 16u; // A slice: row group
  var acc0 = vec4f(0.0);
  var acc1 = vec4f(0.0);
  var acc2 = vec4f(0.0);
  var acc3 = vec4f(0.0);
  for (var k0 = 0u; k0 < n; k0 += 16u) {
    let a = (r0 + lr * 4u) * n + k0 + la;
    As[la * 16u + lr] = vec4f(A[a], A[a + n], A[a + 2u * n], A[a + 3u * n]);
    Bs[li] = B[(k0 + lr) * n4 + c0 / 4u + la];
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) {
      let av = As[k * 16u + lid.y];
      let bv = Bs[k * 16u + lid.x];
      acc0 += av.x * bv;
      acc1 += av.y * bv;
      acc2 += av.z * bv;
      acc3 += av.w * bv;
    }
    workgroupBarrier();
  }
  let c = (r0 + lid.y * 4u) * n4 + c0 / 4u + lid.x;
  C[c] = acc0;
  C[c + n4] = acc1;
  C[c + 2u * n4] = acc2;
  C[c + 3u * n4] = acc3;
}
`;

export function createGpuMatmul(): GpuKernel {
  let device: GPUDevice | undefined;
  let n = 0;
  let pipeline: GPUComputePipeline | undefined;
  let bindGroup: GPUBindGroup | undefined;
  let cBuf: GPUBuffer | undefined;
  const buffers: GPUBuffer[] = [];
  let a = new Float32Array(0);
  let b = new Float32Array(0);
  let seed0 = 0;

  return {
    async prepare(ctx: GpuContext, seed: number, size: number): Promise<void> {
      const dev = requireDevice(ctx.device, NAME);
      device = dev;
      n = size;
      seed0 = seed;
      if (!Number.isInteger(n) || n < BLOCK || n % BLOCK !== 0) {
        throw new Error(`${NAME}: size ${size} is not a positive multiple of ${BLOCK}`);
      }
      const l = dev.limits;
      if (
        l.maxComputeInvocationsPerWorkgroup < 256 ||
        l.maxComputeWorkgroupSizeX < 16 ||
        l.maxComputeWorkgroupSizeY < 16 ||
        l.maxComputeWorkgroupStorageSize < 8192
      ) {
        throw new Error(`${NAME}: GPU limits too small for 16x16 workgroups with 8 KiB shared memory`);
      }
      if (n / BLOCK > l.maxComputeWorkgroupsPerDimension) {
        throw new Error(`${NAME}: size ${n} needs more workgroups than this GPU allows`);
      }
      const bytes = n * n * 4;
      checkStorageSize(dev, NAME, bytes);

      const r = rng(seed);
      a = new Float32Array(n * n);
      b = new Float32Array(n * n);
      for (let i = 0; i < a.length; i++) a[i] = r();
      for (let i = 0; i < b.length; i++) b[i] = r();

      const modules: GPUShaderModule[] = [];
      await scoped(
        dev,
        NAME,
        () => {
          const module = dev.createShaderModule({ label: NAME, code: SHADER });
          modules.push(module);
          const make = (label: string, usage: number, data?: Float32Array): GPUBuffer => {
            const buf = dev.createBuffer({ label: `${NAME} ${label}`, size: bytes, usage });
            buffers.push(buf);
            if (data) dev.queue.writeBuffer(buf, 0, data);
            return buf;
          };
          const ro = Usage.STORAGE | Usage.COPY_DST;
          const aBuf = make('A', ro, a);
          const bBuf = make('B', ro, b);
          cBuf = make('C', Usage.STORAGE | Usage.COPY_SRC);
          const params = dev.createBuffer({
            label: `${NAME} n`,
            size: 16,
            usage: Usage.UNIFORM | Usage.COPY_DST,
          });
          buffers.push(params);
          dev.queue.writeBuffer(params, 0, new Uint32Array([n, 0, 0, 0]));

          const pl = dev.createComputePipeline({
            label: NAME,
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
          });
          pipeline = pl;
          bindGroup = dev.createBindGroup({
            layout: pl.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: params } },
              { binding: 1, resource: { buffer: aBuf } },
              { binding: 2, resource: { buffer: bBuf } },
              { binding: 3, resource: { buffer: cBuf } },
            ],
          });
        },
        modules,
      );
      await dev.queue.onSubmittedWorkDone();
    },

    async runBatch(reps: number): Promise<void> {
      const dev = device!;
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline!);
      pass.setBindGroup(0, bindGroup!);
      const g = n / BLOCK;
      for (let k = 0; k < reps; k++) pass.dispatchWorkgroups(g, g);
      pass.end();
      dev.queue.submit([enc.finish()]);
      await dev.queue.onSubmittedWorkDone();
    },

    async validate(): Promise<{ ok: boolean; detail?: string }> {
      const c = new Float32Array(await readBack(device!, cBuf!, n * n * 4));
      // SAMPLES seeded random entries, the four corners, one full row and one
      // full column (so a bug confined to a lane, a strip or the last block
      // row/column cannot slip through). About (SAMPLES + 2n) * n multiply-adds.
      const r = rng(seed0 ^ 0x5bd1e995);
      const row = Math.floor(r() * n);
      const col = Math.floor(r() * n);
      const cells: [number, number][] = [[0, 0], [0, n - 1], [n - 1, 0], [n - 1, n - 1]];
      for (let s = 0; s < SAMPLES; s++) cells.push([Math.floor(r() * n), Math.floor(r() * n)]);
      for (let x = 0; x < n; x++) cells.push([row, x], [x, col]);
      let worst = 0;
      for (const [i, j] of cells) {
        let want = 0;
        for (let k = 0; k < n; k++) want += a[i * n + k]! * b[k * n + j]!;
        const got = c[i * n + j]!;
        const rel = Math.abs(got - want) / want;
        if (!(rel <= TOLERANCE)) {
          return {
            ok: false,
            detail: `C[${i}][${j}] = ${got}, expected ${want.toPrecision(8)} (relative error ${rel.toExponential(2)}, tolerance ${TOLERANCE})`,
          };
        }
        worst = Math.max(worst, rel);
      }
      return { ok: true, detail: `max relative error ${worst.toExponential(2)}` };
    },

    dispose(): void {
      for (const buf of buffers) buf.destroy();
      buffers.length = 0;
      cBuf = undefined;
      bindGroup = undefined;
      pipeline = undefined;
      device = undefined;
    },
  };
}
