// Small helpers shared by the GPU render tests (draws, fragment, fragment-gl).

// WebGPU flag values live in webgpu.ts; re-exported under the names the
// render tests use.
export {
  Usage as BufferUsage,
  TextureUsage,
  ShaderStage,
  MAP_MODE_READ as MAP_READ,
} from './webgpu.ts';

export function alignTo(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

/**
 * Run `create` inside validation + out-of-memory error scopes and throw a clear
 * Error naming `what` if either scope caught something.
 */
export async function withErrorScopes<T>(
  device: GPUDevice,
  what: string,
  create: () => T,
): Promise<T> {
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let value: T;
  try {
    value = create();
  } finally {
    const v = await device.popErrorScope();
    const o = await device.popErrorScope();
    if (o) throw new Error(`${what}: out of GPU memory: ${o.message}`);
    if (v) throw new Error(`${what}: WebGPU validation error: ${v.message}`);
  }
  return value;
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
