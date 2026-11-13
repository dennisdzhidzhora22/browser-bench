// Shared helpers for kernel tests: loading the built .wasm and the JS side of
// the shared checksum/RNG primitives documented in kernels/src/checksum.rs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { instantiateKernels, type KernelModule } from '../../src/lib/harness/wasm.ts';

const WASM_PATH = fileURLToPath(new URL('../../src/generated/kernels.wasm', import.meta.url));

export async function loadKernels(): Promise<KernelModule> {
  return instantiateKernels(new WebAssembly.Module(readFileSync(WASM_PATH)));
}

/** acc = (acc ^ v) * 0x01000193, wrapping u32. */
export function fold(acc: number, v: number): number {
  return Math.imul((acc ^ v) >>> 0, 0x01000193) >>> 0;
}

/** Initial accumulator for `fold`. */
export const START = 0x811c9dc5;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** Folds the exact bits of an f64: low word, then high word. */
export function f64Bits(acc: number, v: number): number {
  f64[0] = v;
  // Little-endian typed array view: [0] is the low word. Every supported
  // platform (and wasm itself) is little-endian.
  return fold(fold(acc, u32[0]!), u32[1]!);
}

/** xorshift32; a zero seed is replaced with 0x9E3779B9. */
export class Rng {
  private x: number;
  constructor(seed: number) {
    this.x = seed >>> 0 === 0 ? 0x9e3779b9 : seed >>> 0;
  }
  nextU32(): number {
    let x = this.x;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.x = x;
    return x;
  }
  /** Uniform in [0, 1): (next_u32() >> 8) / 16777216. */
  nextF64(): number {
    return (this.nextU32() >>> 8) / 16_777_216;
  }
}
