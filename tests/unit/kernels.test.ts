import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MIX_EXPECTED, MIX_SEED, MIX_SIZES } from '../../src/lib/bench/mix.ts';
import { ABI_VERSION, instantiateKernels, type KernelExports } from '../../src/lib/harness/wasm.ts';

const WASM_PATH = fileURLToPath(new URL('../../src/generated/kernels.wasm', import.meta.url));

/** Independent JS mirror of the reference algorithm in kernels/src/mix.rs. */
function mixReference(seed: number, iterations: number): number {
  let x = seed >>> 0 === 0 ? 0x9e3779b9 : seed >>> 0;
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    const rotl = ((acc << 5) | (acc >>> 27)) >>> 0;
    acc = Math.imul((rotl ^ x) >>> 0, 0x01000193) >>> 0;
  }
  return acc;
}

let kernels: KernelExports;

beforeAll(async () => {
  const module = new WebAssembly.Module(readFileSync(WASM_PATH));
  kernels = await instantiateKernels(module);
});

describe('kernels.wasm', () => {
  it('reports the ABI version the page expects', () => {
    expect(kernels.abi_version()).toBe(ABI_VERSION);
  });

  it('exports linear memory', () => {
    expect(kernels.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  it('rejects a module with a mismatched ABI version', async () => {
    // Minimal module exporting abi_version() -> 9999.
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, // type: () -> i32
      0x03, 0x02, 0x01, 0x00, // func 0 : type 0
      0x07, 0x0f, 0x01, 0x0b, 0x61, 0x62, 0x69, 0x5f, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x00, // export
      0x0a, 0x07, 0x01, 0x05, 0x00, 0x41, 0x8f, 0x4e, 0x0b, // body: i32.const 9999
    ]);
    await expect(instantiateKernels(new WebAssembly.Module(bytes))).rejects.toThrow(/ABI mismatch/);
  });

  it('kernel_mix matches the expected checksum at smoke size', () => {
    expect(kernels.kernel_mix(MIX_SEED, MIX_SIZES.smoke) >>> 0).toBe(MIX_EXPECTED.smoke);
  });

  it('kernel_mix matches the expected checksum at standard size', () => {
    expect(kernels.kernel_mix(MIX_SEED, MIX_SIZES.standard) >>> 0).toBe(MIX_EXPECTED.standard);
  });

  it('the JS mirror reproduces MIX_EXPECTED.smoke', () => {
    expect(mixReference(MIX_SEED, MIX_SIZES.smoke)).toBe(MIX_EXPECTED.smoke);
  });

  it('is deterministic across calls', () => {
    const a = kernels.kernel_mix(MIX_SEED, MIX_SIZES.smoke) >>> 0;
    const b = kernels.kernel_mix(MIX_SEED, MIX_SIZES.smoke) >>> 0;
    expect(a).toBe(b);
  });

  it('returns 0 for zero iterations', () => {
    expect(kernels.kernel_mix(MIX_SEED, 0) >>> 0).toBe(0);
    expect(kernels.kernel_mix(0, 0) >>> 0).toBe(0);
  });

  const cases: Array<[seed: number, iterations: number]> = [
    [MIX_SEED, MIX_SIZES.smoke],
    [0, 1_000], // seed 0 uses the 0x9E3779B9 substitute
    [0, 1],
    [1, 1],
    [2, 7],
    [42, 12_345],
    [0xdeadbeef, 5_000],
    [0xffffffff, 3_333],
    [0x9e3779b9, 1_000], // equals the seed-0 substitute
    [123_456_789, 100_000],
  ];

  it.each(cases)('matches the JS mirror for seed=%i iterations=%i', (seed, iterations) => {
    expect(kernels.kernel_mix(seed, iterations) >>> 0).toBe(mixReference(seed, iterations));
  });

  it('seed 0 behaves like seed 0x9E3779B9', () => {
    expect(kernels.kernel_mix(0, 1_000) >>> 0).toBe(kernels.kernel_mix(0x9e3779b9, 1_000) >>> 0);
  });
});
