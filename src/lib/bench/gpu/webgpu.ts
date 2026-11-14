// Small WebGPU helpers shared by the compute tests (n-body, matmul).

/**
 * GPUBufferUsage / GPUMapMode flag values from the WebGPU spec. TypeScript's
 * DOM lib has the WebGPU interfaces but not these globals, and we add no
 * @webgpu/types dependency.
 */
export const Usage = {
  MAP_READ: 0x1,
  COPY_SRC: 0x4,
  COPY_DST: 0x8,
  UNIFORM: 0x40,
  STORAGE: 0x80,
} as const;
const MAP_MODE_READ = 0x1;

/** Deterministic PRNG (xorshift32) so inputs depend only on the seed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296; // [0, 1)
  };
}

export function requireDevice(device: GPUDevice | undefined, name: string): GPUDevice {
  if (!device) throw new Error(`${name}: WebGPU device not available`);
  return device;
}

/**
 * Run `fn` inside validation and out-of-memory error scopes and throw a clear
 * Error if either one caught something. Compile messages of the shader modules
 * in `modules` (which `fn` may fill) are included.
 */
export async function scoped<T>(
  device: GPUDevice,
  name: string,
  fn: () => T,
  modules: GPUShaderModule[] = [],
): Promise<T> {
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let value: T;
  try {
    value = fn();
  } finally {
    const validation = await device.popErrorScope();
    const oom = await device.popErrorScope();
    if (oom) throw new Error(`${name}: out of GPU memory (${oom.message})`);
    if (validation) {
      let detail = validation.message;
      for (const m of modules) {
        const info = await m.getCompilationInfo();
        for (const msg of info.messages) {
          if (msg.type === 'error') detail += `\n  WGSL ${msg.lineNum}:${msg.linePos} ${msg.message}`;
        }
      }
      throw new Error(`${name}: WebGPU validation error: ${detail}`);
    }
  }
  return value;
}

/** Copy `size` bytes of `src` (needs COPY_SRC) to the CPU. Untimed paths only. */
export async function readBack(
  device: GPUDevice,
  src: GPUBuffer,
  size: number,
): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    size,
    usage: Usage.MAP_READ | Usage.COPY_DST,
  });
  try {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, size);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(MAP_MODE_READ);
    return staging.getMappedRange().slice(0);
  } finally {
    staging.destroy();
  }
}

/** Throw unless `bytes` fits in one storage buffer binding on this device. */
export function checkStorageSize(device: GPUDevice, name: string, bytes: number): void {
  const max = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  if (bytes > max) {
    throw new Error(`${name}: needs a ${bytes} B storage buffer, this GPU allows ${max} B`);
  }
}
