// gpu_fragment: one full-screen triangle per frame into an offscreen rgba8unorm
// texture, shaded by a ray-marched SDF scene (raymarch.ts). Measures pixel
// shading throughput. Never drawn to a presented canvas.
import type { KernelDef } from '../types.ts';
import { checkFragmentImage, fragmentHeight, fragmentWork, WGSL_SCENE } from './raymarch.ts';
import {
  alignTo,
  BufferUsage,
  checkSize,
  compileWgsl,
  MAP_READ,
  TextureUsage,
  withErrorScopes,
} from './render-util.ts';
import { GPU_TARGET_MS, GPU_VALID, type GpuContext, type GpuKernel } from './types.ts';

export const gpuFragment: KernelDef = {
  id: 'gpu_fragment',
  name: 'Ray-march (fragment)',
  stresses: 'pixel shading',
  unit: 'Mpixels/s',
  seed: 1,
  // Image width; height = width * 9 / 16 (1920 x 1080 at standard).
  sizes: { smoke: 64, standard: 1920 },
  expected: { smoke: GPU_VALID, standard: GPU_VALID },
  work: fragmentWork,
  targetMs: GPU_TARGET_MS,
};

export function createGpuFragment(): GpuKernel {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  let uniforms: GPUBuffer | undefined;
  let readback: GPUBuffer | undefined;
  let pipeline: GPURenderPipeline | undefined;
  let bindGroup: GPUBindGroup | undefined;
  let pass: GPURenderPassDescriptor | undefined;
  let w = 0;
  let h = 0;
  let bytesPerRow = 0;

  return {
    async prepare(ctx: GpuContext, _seed: number, size: number): Promise<void> {
      const dev = ctx.device;
      if (!dev) throw new Error('gpu_fragment: needs WebGPU');
      checkSize('gpu_fragment', size);
      device = dev;
      w = size;
      h = fragmentHeight(size);
      const max = dev.limits.maxTextureDimension2D;
      if (w > max || h > max) {
        throw new Error(`gpu_fragment: ${w}x${h} exceeds maxTextureDimension2D ${max}`);
      }
      bytesPerRow = alignTo(w * 4, 256);
      if (bytesPerRow * h > dev.limits.maxBufferSize) {
        throw new Error('gpu_fragment: readback buffer exceeds maxBufferSize');
      }
      const module = await compileWgsl(dev, 'gpu_fragment', WGSL_SCENE);
      await withErrorScopes(dev, 'gpu_fragment', () => {
        const tex = dev.createTexture({
          label: 'gpu_fragment target',
          size: [w, h],
          format: 'rgba8unorm',
          usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
        });
        target = tex;
        const ubuf = dev.createBuffer({
          label: 'gpu_fragment uniforms',
          size: 16,
          usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
        uniforms = ubuf;
        dev.queue.writeBuffer(ubuf, 0, new Float32Array([w, h, 0, 0]));
        readback = dev.createBuffer({
          label: 'gpu_fragment readback',
          size: bytesPerRow * h,
          usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
        });
        const pipe = dev.createRenderPipeline({
          label: 'gpu_fragment',
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        });
        pipeline = pipe;
        bindGroup = dev.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: ubuf } }],
        });
        pass = {
          colorAttachments: [
            { view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
          ],
        };
      });
    },

    async runBatch(reps: number): Promise<void> {
      // One encoder and one submit for the whole batch (one render pass per
      // frame), so per-submit CPU cost does not leak into the pixel rate.
      const dev = device!;
      const enc = dev.createCommandEncoder();
      for (let r = 0; r < reps; r++) {
        const rp = enc.beginRenderPass(pass!);
        rp.setPipeline(pipeline!);
        rp.setBindGroup(0, bindGroup!);
        rp.draw(3);
        rp.end();
      }
      dev.queue.submit([enc.finish()]);
      await dev.queue.onSubmittedWorkDone();
    },

    async validate(): Promise<{ ok: boolean; detail?: string }> {
      const dev = device!;
      const buf = readback!;
      await withErrorScopes(dev, 'gpu_fragment readback', () => {
        const enc = dev.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: target! }, { buffer: buf, bytesPerRow }, [w, h]);
        dev.queue.submit([enc.finish()]);
      });
      await buf.mapAsync(MAP_READ);
      try {
        const px = new Uint8Array(buf.getMappedRange());
        return checkFragmentImage(w, h, px, (x, y) => y * bytesPerRow + x * 4);
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
      device = undefined;
    },
  };
}
