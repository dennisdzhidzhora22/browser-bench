// Fetches and compiles the kernel module once per page. Workers receive the
// compiled WebAssembly.Module, so they never fetch or compile it themselves.
import kernelsUrl from '../../generated/kernels.wasm?url';

let compiled: Promise<WebAssembly.Module> | undefined;

export function loadKernelModule(): Promise<WebAssembly.Module> {
  compiled ??= WebAssembly.compileStreaming(fetch(kernelsUrl)).catch((err: unknown) => {
    compiled = undefined; // allow a retry on the next run
    throw err;
  });
  return compiled;
}
