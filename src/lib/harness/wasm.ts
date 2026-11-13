// Typed access to the Rust kernel module (kernels/src/lib.rs).

/** Must equal `abi_version()` in kernels/src/lib.rs. */
export const ABI_VERSION = 4;

export interface KernelFns {
  prepare(seed: number, size: number): number;
  run(): number;
}

export interface KernelModule {
  memory: WebAssembly.Memory;
  abi_version(): number;
  /** Looks up `<id>_prepare` / `<id>_run`. Throws if either is missing. */
  kernel(id: string): KernelFns;
}

/** Instantiates a compiled kernel module and checks its ABI version. */
export async function instantiateKernels(module: WebAssembly.Module): Promise<KernelModule> {
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  const abi = exports['abi_version'];
  if (typeof abi !== 'function') throw new Error('kernel module has no abi_version export');
  const found = (abi as () => number)();
  if (found !== ABI_VERSION) {
    throw new Error(`kernel ABI mismatch: module has ${found}, page expects ${ABI_VERSION}`);
  }
  return {
    memory: exports['memory'] as WebAssembly.Memory,
    abi_version: abi as () => number,
    kernel(id) {
      const prepare = exports[`${id}_prepare`];
      const run = exports[`${id}_run`];
      if (typeof prepare !== 'function' || typeof run !== 'function') {
        throw new Error(`kernel "${id}" not found in module`);
      }
      return {
        prepare: prepare as KernelFns['prepare'],
        run: run as KernelFns['run'],
      };
    },
  };
}
