// gpu_fragment_gl: WebGL2 fallback for gpu_fragment, used only when WebGPU is
// missing. Same scene and math (raymarch.ts, GLSL ES 3.00), drawn into an
// RGBA8 texture attached to a framebuffer object, never shown.
import type { KernelDef } from '../types.ts';
import { checkFragmentImage, fragmentHeight, fragmentWork, GLSL_FS, GLSL_VS } from './raymarch.ts';
import { checkSize } from './render-util.ts';
import { GPU_TARGET_MS, GPU_VALID, type GpuContext, type GpuKernel } from './types.ts';

export const gpuFragmentGl: KernelDef = {
  id: 'gpu_fragment_gl',
  name: 'Ray-march (fragment, WebGL2 fallback)',
  stresses: 'pixel shading',
  unit: 'Mpixels/s',
  seed: 1,
  // Image width; height = width * 9 / 16 (1920 x 1080 at standard).
  sizes: { smoke: 64, standard: 1920 },
  expected: { smoke: GPU_VALID, standard: GPU_VALID },
  work: fragmentWork,
  targetMs: GPU_TARGET_MS,
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('gpu_fragment_gl: createShader failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) ?? '';
    gl.deleteShader(s);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`gpu_fragment_gl: ${kind} shader compile error: ${log.trim()}`);
  }
  return s;
}

export function createGpuFragmentGl(): GpuKernel {
  let gl: WebGL2RenderingContext | undefined;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let tex: WebGLTexture | null = null;
  let fbo: WebGLFramebuffer | null = null;
  let w = 0;
  let h = 0;
  /** Target of the 1-pixel sync read in runBatch. */
  const sync = new Uint8Array(4);
  let image: Uint8Array | undefined;

  return {
    async prepare(ctx: GpuContext, _seed: number, size: number): Promise<void> {
      const g = ctx.gl;
      if (!g) throw new Error('gpu_fragment_gl: needs WebGL2');
      if (g.isContextLost()) throw new Error('gpu_fragment_gl: WebGL2 context lost');
      checkSize('gpu_fragment_gl', size);
      gl = g;
      w = size;
      h = fragmentHeight(size);
      const maxTex = g.getParameter(g.MAX_TEXTURE_SIZE) as number;
      const maxView = g.getParameter(g.MAX_VIEWPORT_DIMS) as Int32Array;
      if (w > maxTex || h > maxTex || w > maxView[0]! || h > maxView[1]!) {
        throw new Error(`gpu_fragment_gl: ${w}x${h} exceeds the GPU's texture/viewport limits`);
      }
      while (g.getError() !== g.NO_ERROR) {
        // clear errors left by earlier users of this context
      }

      const vs = compile(g, g.VERTEX_SHADER, GLSL_VS);
      const fs = compile(g, g.FRAGMENT_SHADER, GLSL_FS);
      program = g.createProgram();
      if (!program) throw new Error('gpu_fragment_gl: createProgram failed');
      g.attachShader(program, vs);
      g.attachShader(program, fs);
      g.linkProgram(program);
      g.deleteShader(vs);
      g.deleteShader(fs);
      if (!g.getProgramParameter(program, g.LINK_STATUS)) {
        throw new Error(`gpu_fragment_gl: link error: ${(g.getProgramInfoLog(program) ?? '').trim()}`);
      }

      vao = g.createVertexArray(); // no attributes: the vertex shader uses gl_VertexID
      tex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, tex);
      g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA8, w, h);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.bindTexture(g.TEXTURE_2D, null);
      fbo = g.createFramebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, fbo);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
      const status = g.checkFramebufferStatus(g.FRAMEBUFFER);
      if (status !== g.FRAMEBUFFER_COMPLETE) {
        throw new Error(`gpu_fragment_gl: framebuffer incomplete (0x${status.toString(16)})`);
      }

      // State used by every frame; set once here.
      g.viewport(0, 0, w, h);
      g.disable(g.DEPTH_TEST);
      g.disable(g.BLEND);
      g.disable(g.SCISSOR_TEST);
      g.useProgram(program);
      g.uniform2f(g.getUniformLocation(program, 'uRes'), w, h);
      g.bindVertexArray(vao);
      g.pixelStorei(g.PACK_ALIGNMENT, 1);
      image = new Uint8Array(w * h * 4);

      const err = g.getError();
      if (err !== g.NO_ERROR) throw new Error(`gpu_fragment_gl: GL error 0x${err.toString(16)} in setup`);
    },

    async runBatch(reps: number): Promise<void> {
      const g = gl!;
      for (let r = 0; r < reps; r++) g.drawArrays(g.TRIANGLES, 0, 3);
      // Sync point: WebGL2 has no "work done" promise. Reading one pixel back
      // blocks until every queued draw that writes this framebuffer has finished.
      g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, sync);
    },

    async validate(): Promise<{ ok: boolean; detail?: string }> {
      const g = gl!;
      const px = image!;
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
      const err = g.getError();
      if (err !== g.NO_ERROR) return { ok: false, detail: `GL error 0x${err.toString(16)}` };
      if (g.isContextLost()) return { ok: false, detail: 'WebGL2 context lost' };
      // readPixels rows start at the bottom; the scene counts y from the top.
      return checkFragmentImage(w, h, px, (x, y) => ((h - 1 - y) * w + x) * 4);
    },

    dispose(): void {
      const g = gl;
      if (!g) return;
      try {
        g.bindVertexArray(null);
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.useProgram(null);
        g.deleteFramebuffer(fbo);
        g.deleteTexture(tex);
        g.deleteVertexArray(vao);
        g.deleteProgram(program);
      } catch {
        // context may be lost; nothing to free then
      }
      fbo = tex = vao = program = null;
      image = undefined;
      gl = undefined;
    },
  };
}
