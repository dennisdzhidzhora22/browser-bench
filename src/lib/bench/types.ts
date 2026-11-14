// Shared shape of a benchmark kernel definition.

export type ComponentId = 'cpu-single' | 'cpu-multi' | 'memory' | 'gpu' | 'storage';

/** `smoke` finishes in milliseconds and exists for automated tests only. */
export type SizeId = 'smoke' | 'standard';

export interface KernelDef {
  /** Wasm export prefix: the module exports `<id>_prepare` and `<id>_run`. */
  id: string;
  /** Tells apart several defs that share one wasm kernel (e.g. latency sizes). */
  variant?: string;
  /** Short display name. */
  name: string;
  /** What the kernel stresses, a few words. */
  stresses: string;
  /** Unit of the headline number, e.g. 'MB/s', 'GFLOP/s'. */
  unit: string;
  seed: number;
  /** `size` argument to `<id>_prepare`. `standard` runs ≥ 250 ms per `run` call. */
  sizes: Record<SizeId, number>;
  /** Checksum `<id>_run` returns for `seed` at each size. */
  expected: Record<SizeId, number>;
  /**
   * Work done by one `run` call at `size`, in the unit's numerator
   * (MB for MB/s, GFLOP for GFLOP/s, ...). Throughput = work / seconds.
   */
  work(size: number): number;
  /** True for the simd128 variant of a kernel. */
  simd?: boolean;
  /**
   * Size for the all-cores test, when `standard` uses too much memory to run
   * one instance per core (target: under ~16 MB of wasm memory per instance).
   * Short runs are fine there: the all-cores harness repeats `run` to fill
   * each timed window. Absent = use `standard`.
   */
  multi?: { size: number; expected: number };
}

/** Unique key for lists: id plus variant. */
export function defKey(def: KernelDef): string {
  return def.variant ? `${def.id}:${def.variant}` : def.id;
}
