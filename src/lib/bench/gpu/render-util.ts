// Small helpers shared by the GPU render tests (draws, fragment, fragment-gl).

// WebGPU flags and the error-scope helper live in webgpu.ts; re-exported
// under the names the render tests use.
export {
  Usage as BufferUsage,
  TextureUsage,
  ShaderStage,
  MAP_MODE_READ as MAP_READ,
  scoped as withErrorScopes,
} from './webgpu.ts';

export function alignTo(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

/** Create a shader module and throw with the compiler's messages if it has errors. */
export async function compileWgsl(device: GPUDevice, what: string, code: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ label: what, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    const text = errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ');
    throw new Error(`${what}: WGSL compile error: ${text}`);
  }
  return module;
}

/** Throw if `size` is not a positive integer. */
export function checkSize(what: string, size: number): void {
  if (!Number.isInteger(size) || size < 1) throw new Error(`${what}: bad size ${size}`);
}
