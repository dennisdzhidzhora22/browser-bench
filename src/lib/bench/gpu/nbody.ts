// N-body compute test (docs/SPEC.md, 3.4).
//
// size = N bodies. Each body is a vec4 (xyz position, w mass) plus a vec4
// velocity, in storage buffers that ping-pong between two sets. One iteration
// is one dispatch that, for every body i, sums the softened gravity of all N
// bodies (G = 1):
//   a_i = sum_j m_j * d_ij / (|d_ij|^2 + eps^2)^(3/2),   d_ij = p_j - p_i
// then takes a symplectic Euler step: v' = v + a*dt, p' = p + v'*dt.
// The j-loop is tiled through workgroup memory: each invocation loads one body
// of the tile, the workgroup syncs, then every invocation reads the whole tile.
// Self-interaction contributes 0 (d = 0, softening keeps the division finite),
// so it is counted in the work: N*N interactions per iteration.
//
// Validation: the timed batches advance the state an unknown number of steps,
// so validate() runs ONE extra step from the saved initial state into scratch
// buffers and compares 32 bodies' velocity change with a CPU f64 computation of
// the same step (see TOLERANCE). It also checks the new positions follow from
// the new velocities, and that the timed state is finite with masses intact.

import type { KernelDef } from '../types.ts';
import { GPU_TARGET_MS, GPU_VALID, type GpuContext, type GpuKernel } from './types.ts';
import { checkStorageSize, readBack, requireDevice, rng, scoped, Usage } from './webgpu.ts';

export const gpuNbody: KernelDef = {
  id: 'gpu_nbody',
  name: 'N-body (compute)',
  stresses: 'compute, shared memory',
  unit: 'G interactions/s',
  seed: 1,
  sizes: { smoke: 256, standard: 32768 },
  expected: { smoke: GPU_VALID, standard: GPU_VALID },
  work: (n) => (n * n) / 1e9,
  targetMs: GPU_TARGET_MS,
};

const NAME = 'gpu_nbody';
const DT = 0.001;
const EPS2 = 0.05 * 0.05;
const SAMPLES = 32;

/**
 * Relative tolerance on a body's velocity change (one step). Each GPU result is
 * a sum of N f32 terms; with rounding (~6e-8 per op, inverseSqrt a few ulp)
 * the accumulated error is a random walk, about sqrt(N) * 1e-7 of the sum of
 * term sizes (~2e-5 at N = 32768); the strict worst case N * 6e-8 needs every
 * rounding to go the same way and does not happen. Vector sums can cancel, so
 * the denominator is |dv| plus 1% of sum_j |term_j| * dt: the check stays
 * meaningful for bodies whose pulls nearly cancel. Any real bug (wrong index,
 * sign, missing tile, missing softening) is off by far more.
 */
const TOLERANCE = 1e-3;

function shader(wg: number): string {
  return /* wgsl */ `
struct Params { n: u32, dt: f32, eps2: f32, pad: f32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec4f>;
@group(0) @binding(2) var<storage, read> velIn: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> posOut: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> velOut: array<vec4f>;

const WG = ${wg}u;
var<workgroup> tile: array<vec4f, WG>;

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = gid.x;
  let live = i < P.n;
  var p = vec4f(0.0);
  if (live) { p = posIn[i]; }
  var acc = vec3f(0.0);
  for (var base = 0u; base < P.n; base += WG) {
    let j = base + li;
    var q = vec4f(0.0); // mass 0 pads the last tile
    if (j < P.n) { q = posIn[j]; }
    tile[li] = q;
    workgroupBarrier();
    for (var k = 0u; k < WG; k++) {
      let b = tile[k];
      let d = b.xyz - p.xyz;
      let inv = inverseSqrt(dot(d, d) + P.eps2);
      acc += d * (b.w * inv * inv * inv);
    }
    workgroupBarrier();
  }
  if (live) {
    let v = velIn[i].xyz + acc * P.dt;
    velOut[i] = vec4f(v, 0.0);
    posOut[i] = vec4f(p.xyz + v * P.dt, p.w);
  }
}
`;
}

/** Largest workgroup size of 256/128/64 the device allows (tile = 16 B per body). */
function pickWorkgroup(device: GPUDevice): number {
  const l = device.limits;
  for (const wg of [256, 128, 64]) {
    if (
      wg <= l.maxComputeInvocationsPerWorkgroup &&
      wg <= l.maxComputeWorkgroupSizeX &&
      wg * 16 <= l.maxComputeWorkgroupStorageSize
    ) {
      return wg;
    }
  }
  throw new Error(`${NAME}: GPU limits too small for a 64-body tile`);
}

export function createGpuNbody(): GpuKernel {
  let device: GPUDevice | undefined;
  let n = 0;
  let groups = 0;
  let pipeline: GPUComputePipeline | undefined;
  const buffers: GPUBuffer[] = [];
  let pos: GPUBuffer[] = [];
  let posS: GPUBuffer | undefined;
  let velS: GPUBuffer | undefined;
  let step: GPUBindGroup[] = []; // [0]: set 0 -> set 1, [1]: set 1 -> set 0
  let check: GPUBindGroup | undefined; // initial -> scratch
  let parity = 0; // which set holds the current state
  let pos0 = new Float32Array(0);
  let vel0 = new Float32Array(0);

  return {
    async prepare(ctx: GpuContext, seed: number, size: number): Promise<void> {
      const dev = requireDevice(ctx.device, NAME);
      device = dev;
      n = size;
      if (!Number.isInteger(n) || n < 1) throw new Error(`${NAME}: bad size ${size}`);
      const bytes = n * 16;
      checkStorageSize(dev, NAME, bytes);
      const wg = pickWorkgroup(dev);
      groups = Math.ceil(n / wg);
      if (groups > dev.limits.maxComputeWorkgroupsPerDimension) {
        throw new Error(`${NAME}: ${groups} workgroups exceed this GPU's limit`);
      }

      // Bodies uniform in [-1, 1]^3, total mass about 1, small random velocities.
      const r = rng(seed);
      pos0 = new Float32Array(n * 4);
      vel0 = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        pos0[i * 4] = r() * 2 - 1;
        pos0[i * 4 + 1] = r() * 2 - 1;
        pos0[i * 4 + 2] = r() * 2 - 1;
        pos0[i * 4 + 3] = (0.5 + r()) / n;
        vel0[i * 4] = (r() - 0.5) * 0.02;
        vel0[i * 4 + 1] = (r() - 0.5) * 0.02;
        vel0[i * 4 + 2] = (r() - 0.5) * 0.02;
      }

      const modules: GPUShaderModule[] = [];
      await scoped(
        dev,
        NAME,
        () => {
          const module = dev.createShaderModule({ label: NAME, code: shader(wg) });
          modules.push(module);
          const usage =
            Usage.STORAGE | Usage.COPY_DST | Usage.COPY_SRC;
          const make = (label: string, data?: Float32Array): GPUBuffer => {
            const b = dev.createBuffer({ label: `${NAME} ${label}`, size: bytes, usage });
            buffers.push(b);
            if (data) dev.queue.writeBuffer(b, 0, data);
            return b;
          };
          pos = [make('pos0', pos0), make('pos1')];
          const vel = [make('vel0', vel0), make('vel1')];
          const posInit = make('posInit', pos0);
          const velInit = make('velInit', vel0);
          posS = make('posCheck');
          velS = make('velCheck');

          const params = dev.createBuffer({
            label: `${NAME} params`,
            size: 16,
            usage: Usage.UNIFORM | Usage.COPY_DST,
          });
          buffers.push(params);
          const p = new ArrayBuffer(16);
          new Uint32Array(p, 0, 1)[0] = n;
          new Float32Array(p, 4, 2).set([DT, EPS2]);
          dev.queue.writeBuffer(params, 0, p);

          const pl = dev.createComputePipeline({
            label: NAME,
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
          });
          pipeline = pl;
          const bind = (pi: GPUBuffer, vi: GPUBuffer, po: GPUBuffer, vo: GPUBuffer) =>
            dev.createBindGroup({
              layout: pl.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: { buffer: pi } },
                { binding: 2, resource: { buffer: vi } },
                { binding: 3, resource: { buffer: po } },
                { binding: 4, resource: { buffer: vo } },
              ],
            });
          const [p0, p1] = pos as [GPUBuffer, GPUBuffer];
          const [v0, v1] = vel as [GPUBuffer, GPUBuffer];
          step = [bind(p0, v0, p1, v1), bind(p1, v1, p0, v0)];
          check = bind(posInit, velInit, posS, velS);
        },
        modules,
      );
      parity = 0;
      await dev.queue.onSubmittedWorkDone();
    },

    async runBatch(reps: number): Promise<void> {
      const dev = device!;
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline!);
      for (let k = 0; k < reps; k++) {
        pass.setBindGroup(0, step[parity]!);
        pass.dispatchWorkgroups(groups);
        parity ^= 1;
      }
      pass.end();
      dev.queue.submit([enc.finish()]);
      await dev.queue.onSubmittedWorkDone();
    },

    async validate(): Promise<{ ok: boolean; detail?: string }> {
      const dev = device!;
      const bytes = n * 16;

      // Timed state: finite, masses unchanged, and it actually moved (a timed
      // submit that failed validation would leave the initial state in place).
      const cur = new Float32Array(await readBack(dev, pos[parity]!, bytes));
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (![cur[o]!, cur[o + 1]!, cur[o + 2]!].every(Number.isFinite) || cur[o + 3] !== pos0[o + 3]) {
          return { ok: false, detail: `body ${i} after the timed steps is not finite or lost its mass` };
        }
        if (cur[o] !== pos0[o] || cur[o + 1] !== pos0[o + 1] || cur[o + 2] !== pos0[o + 2]) moved++;
      }
      if (moved < n / 2) {
        return { ok: false, detail: `only ${moved} of ${n} bodies moved during the timed steps` };
      }

      // One step from the initial state, compared with CPU f64.
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline!);
      pass.setBindGroup(0, check!);
      pass.dispatchWorkgroups(groups);
      pass.end();
      dev.queue.submit([enc.finish()]);
      const vel1 = new Float32Array(await readBack(dev, velS!, bytes));
      const pos1 = new Float32Array(await readBack(dev, posS!, bytes));

      const eps2 = Math.fround(EPS2);
      const dt = Math.fround(DT);
      let worst = 0;
      // Seeded random bodies (so every lane of a workgroup can be hit), plus
      // body 0 and the last body (its tile is partly padding).
      const pick = rng(0x9e3779b9);
      for (let s = 0; s < SAMPLES; s++) {
        const i =
          s === 0 ? 0 : s === 1 ? n - 1 : Math.min(n - 1, Math.floor(pick() * n));
        const o = i * 4;
        const px = pos0[o]!, py = pos0[o + 1]!, pz = pos0[o + 2]!;
        let ax = 0, ay = 0, az = 0, sum = 0;
        for (let j = 0; j < n; j++) {
          const q = j * 4;
          const dx = pos0[q]! - px, dy = pos0[q + 1]! - py, dz = pos0[q + 2]! - pz;
          const r2 = dx * dx + dy * dy + dz * dz;
          const f = pos0[q + 3]! / Math.pow(r2 + eps2, 1.5);
          ax += dx * f;
          ay += dy * f;
          az += dz * f;
          sum += Math.sqrt(r2) * f;
        }
        const ex = vel1[o]! - vel0[o]! - ax * dt;
        const ey = vel1[o + 1]! - vel0[o + 1]! - ay * dt;
        const ez = vel1[o + 2]! - vel0[o + 2]! - az * dt;
        const denom = (Math.hypot(ax, ay, az) + 0.01 * sum) * dt;
        const rel = Math.hypot(ex, ey, ez) / denom;
        if (!(rel <= TOLERANCE)) {
          return {
            ok: false,
            detail: `body ${i}: velocity change off by ${rel.toExponential(2)} (relative), tolerance ${TOLERANCE}`,
          };
        }
        worst = Math.max(worst, rel);
        // p' = p + v' * dt, f32 rounding only.
        for (let c = 0; c < 3; c++) {
          const want = pos0[o + c]! + vel1[o + c]! * dt;
          if (!(Math.abs(pos1[o + c]! - want) <= 1e-6 * (1 + Math.abs(want)))) {
            return { ok: false, detail: `body ${i}: new position does not follow from new velocity` };
          }
        }
      }
      return { ok: true, detail: `max relative error ${worst.toExponential(2)}` };
    },

    dispose(): void {
      for (const b of buffers) b.destroy();
      buffers.length = 0;
      pos = [];
      step = [];
      check = undefined;
      pipeline = undefined;
      device = undefined;
    },
  };
}
