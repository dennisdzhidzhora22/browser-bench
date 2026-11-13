// Typed view of the Rust kernel module's exports (kernels/src/lib.rs).

/** Must equal `abi_version()` in kernels/src/lib.rs. */
export const ABI_VERSION = 1;

export interface KernelExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  kernel_mix(seed: number, iterations: number): number;
}

/** Instantiates a compiled kernel module and checks its ABI version. */
export async function instantiateKernels(module: WebAssembly.Module): Promise<KernelExports> {
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as KernelExports;
  const found = exports.abi_version();
  if (found !== ABI_VERSION) {
    throw new Error(`kernel ABI mismatch: module has ${found}, page expects ${ABI_VERSION}`);
  }
  return exports;
}
