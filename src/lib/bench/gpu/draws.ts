// gpu_draws: many small draws per frame into an offscreen rgba8unorm texture.
// Measures API + driver overhead per draw: each draw is a 4x4-pixel quad in its
// own 8x8 grid cell, with its own position and colour picked by a per-draw
// setBindGroup with a dynamic uniform offset. Encoding the D draws is part of
// the timed work on purpose; that is what a draw-call test measures.
import type { KernelDef } from '../types.ts';
import {
  alignTo,
  BufferUsage,
  checkSize,
  compileWgsl,
  MAP_READ,
  ShaderStage,
  TextureUsage,
  withErrorScopes,
} from './render-util.ts';
import { GPU_TARGET_MS, GPU_VALID, type GpuContext, type GpuKernel } from './types.ts';

export const gpuDraws: KernelDef = {
  id: 'gpu_draws',
  name: 'Draw calls',
  stresses: 'API + driver overhead',
  unit: 'K draws/s',
  seed: 1,
  // Draws per frame (one frame = one render pass, one submit).
  sizes: { smoke: 64, standard: 10_000 },
  expected: { smoke: GPU_VALID, standard: GPU_VALID },
  work: (d) => d / 1e3,
  targetMs: GPU_TARGET_MS,
};

/** Grid cell size and the quad inside it, in pixels: quad covers [INSET, INSET + QUAD). */
const CELL = 8;
const INSET = 2;
const QUAD = 4;
/** Bytes of per-draw uniform data actually used (offset, scale, colour). */
const DRAW_BYTES = 32;

const WGSL = /* wgsl */ `
struct Draw { offset: vec2f, scale: vec2f, color: vec4f }
@group(0) @binding(0) var<uniform> d: Draw;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var q = array(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
                vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  return vec4f(d.offset + q[i] * d.scale, 0.0, 1.0);
}

@fragment fn fs() -> @location(0) vec4f {
  return d.color;
}
`;

/** Colour bytes of draw `i` (never the clear colour: red is at least 1). */
function drawColor(i: number, seed: number): [number, number, number] {
  let x = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  return [1 + ((x >>> 0) % 255), (x >>> 8) & 255, (x >>> 16) & 255];
}

export function createGpuDraws(): GpuKernel {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  let uniforms: GPUBuffer | undefined;
  let readback: GPUBuffer | undefined;
  let pipeline: GPURenderPipeline | undefined;
  let bindGroup: GPUBindGroup | undefined;
  let pass: GPURenderPassDescriptor | undefined;
  let offsets = new Uint32Array(0);
  let draws = 0;
  let grid = 0;
  let w = 0;
  let h = 0;
  let bytesPerRow = 0;
  let seed = 0;

  return {
    async prepare(ctx: GpuContext, s: number, size: number): Promise<void> {
      const dev = ctx.device;
      if (!dev) throw new Error('gpu_draws: needs WebGPU');
      checkSize('gpu_draws', size);
      device = dev;
      seed = s;
      draws = size;
      grid = Math.ceil(Math.sqrt(draws));
      w = grid * CELL;
      h = Math.ceil(draws / grid) * CELL;
      const lim = dev.limits;
      if (w > lim.maxTextureDimension2D || h > lim.maxTextureDimension2D) {
        throw new Error(`gpu_draws: ${w}x${h} target exceeds maxTextureDimension2D`);
      }
      const stride = alignTo(DRAW_BYTES, Math.max(256, lim.minUniformBufferOffsetAlignment));
      if (draws * stride > lim.maxBufferSize) throw new Error('gpu_draws: uniform buffer too large');
      bytesPerRow = alignTo(w * 4, 256);

      // Per-draw data: NDC offset of the quad's top-left corner, size, colour.
      // Positions sit on whole pixels, so coverage of the 4x4 quad is exact.
      const data = new ArrayBuffer(draws * stride);
      offsets = new Uint32Array(draws);
      for (let i = 0; i < draws; i++) {
        const f = new Float32Array(data, i * stride, DRAW_BYTES / 4);
        const x0 = (i % grid) * CELL + INSET;
        const y0 = Math.floor(i / grid) * CELL + INSET;
        const [r, g, b] = drawColor(i, seed);
        f.set([(x0 / w) * 2 - 1, 1 - (y0 / h) * 2, (QUAD / w) * 2, (-QUAD / h) * 2]);
        f.set([r / 255, g / 255, b / 255, 1], 4);
        offsets[i] = i * stride;
      }

      const module = await compileWgsl(dev, 'gpu_draws', WGSL);
      await withErrorScopes(dev, 'gpu_draws', () => {
        const tex = dev.createTexture({
          label: 'gpu_draws target',
          size: [w, h],
          format: 'rgba8unorm',
          usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
        });
        target = tex;
        const ubuf = dev.createBuffer({
          label: 'gpu_draws uniforms',
          size: data.byteLength,
          usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
        uniforms = ubuf;
        dev.queue.writeBuffer(ubuf, 0, data);
        readback = dev.createBuffer({
          label: 'gpu_draws readback',
          size: bytesPerRow * h,
          usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
        });
        const layout = dev.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
              buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_BYTES },
            },
          ],
        });
        pipeline = dev.createRenderPipeline({
          label: 'gpu_draws',
          layout: dev.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        });
        bindGroup = dev.createBindGroup({
          layout,
          entries: [{ binding: 0, resource: { buffer: ubuf, size: DRAW_BYTES } }],
        });
        pass = {
          colorAttachments: [
            { view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
          ],
        };
      });
    },

    async runBatch(reps: number): Promise<void> {
      const dev = device!;
      const pipe = pipeline!;
      const bg = bindGroup!;
      const offs = offsets;
      for (let r = 0; r < reps; r++) {
        const enc = dev.createCommandEncoder();
        const rp = enc.beginRenderPass(pass!);
        rp.setPipeline(pipe);
        for (let i = 0; i < draws; i++) {
          // Typed-array overload: no per-draw array allocation.
          rp.setBindGroup(0, bg, offs, i, 1);
          rp.draw(6);
        }
        rp.end();
        dev.queue.submit([enc.finish()]);
      }
      await dev.queue.onSubmittedWorkDone();
    },

    async validate(): Promise<{ ok: boolean; detail?: string }> {
      const dev = device!;
      const buf = readback!;
      await withErrorScopes(dev, 'gpu_draws readback', () => {
        const enc = dev.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: target! }, { buffer: buf, bytesPerRow }, [w, h]);
        dev.queue.submit([enc.finish()]);
      });
      await buf.mapAsync(MAP_READ);
      try {
        const px = new Uint8Array(buf.getMappedRange());
        const at = (x: number, y: number) => {
          const o = y * bytesPerRow + x * 4;
          return [px[o]!, px[o + 1]!, px[o + 2]!, px[o + 3]!];
        };
        // First, last, middle and a spread of cells. Colours are k/255, so the
        // stored bytes must match exactly.
        const cells = new Set([0, 1, grid - 1, draws >> 1, draws - 1]);
        for (let k = 1; k <= 4; k++) cells.add(Math.floor((draws * k) / 5.3));
        for (const i of cells) {
          if (i < 0 || i >= draws) continue;
          const cx = (i % grid) * CELL;
          const cy = Math.floor(i / grid) * CELL;
          const want = [...drawColor(i, seed), 255];
          for (const [dx, dy] of [
            [INSET, INSET],
            [INSET + QUAD - 1, INSET + QUAD - 1],
          ] as const) {
            const got = at(cx + dx, cy + dy);
            if (got.some((v, k) => v !== want[k])) {
              return {
                ok: false,
                detail: `draw ${i}: pixel (${cx + dx},${cy + dy}) is ${got.join(',')}, expected ${want.join(',')}`,
              };
            }
          }
          // Just outside the quad must still be the clear colour.
          const out = at(cx + INSET - 1, cy + INSET);
          if (out[0] !== 0 || out[1] !== 0 || out[2] !== 0) {
            return { ok: false, detail: `draw ${i}: quad covers pixels outside its 4x4 area` };
          }
        }
        return { ok: true };
      } finally {
        buf.unmap();
      }
    },

    dispose(): void {
      target?.destroy();
      uniforms?.destroy();
      readback?.destroy();
      target = uniforms = readback = undefined;
      pipeline = undefined;
      bindGroup = undefined;
      pass = undefined;
      offsets = new Uint32Array(0);
      device = undefined;
    },
  };
}
