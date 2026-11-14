// runner.worker.ts init handling, driven in-process: the worker file only needs `self.postMessage`
// and an assignable `self.onmessage`, so a stub `self` is enough (no thread, no wasm).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FromWorker, ToWorker } from '../../src/lib/harness/protocol.ts';

describe('runner.worker init', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadWorker() {
    vi.resetModules(); // fresh module state: no instance left over from another test
    const replies: FromWorker[] = [];
    const fake: {
      postMessage(msg: FromWorker): void;
      onmessage?: (e: { data: ToWorker }) => Promise<void>;
    } = { postMessage: (m) => void replies.push(m) };
    vi.stubGlobal('self', fake);
    await import('../../src/workers/runner.worker.ts');
    expect(typeof fake.onmessage).toBe('function');
    return { replies, send: (data: ToWorker) => fake.onmessage!({ data }) };
  }

  it('init without a module replies an error containing "init without a kernel module"', async () => {
    const { replies, send } = await loadWorker();
    await send({ type: 'init', spinMs: 0 });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.type).toBe('error');
    expect((replies[0] as { message: string }).message).toContain('init without a kernel module');
  });

  it('a GPU-style init (gpu, no module) is rejected by the CPU worker the same way', async () => {
    const { replies, send } = await loadWorker();
    await send({ type: 'init', spinMs: 0, gpu: { preference: 'high-performance', api: 'webgpu' } });
    expect(replies).toHaveLength(1);
    expect((replies[0] as { message: string }).message).toContain('init without a kernel module');
  });

  it('a run after the failed init reports "worker not initialised"', async () => {
    const { replies, send } = await loadWorker();
    await send({ type: 'init', spinMs: 0 });
    await send({
      type: 'run',
      id: 3,
      kernel: 'mix',
      seed: 1,
      size: 10,
      minSamples: 1,
      maxSamples: 1,
      targetSpread: 1,
      maxMs: 1,
    });
    expect(replies[1]).toMatchObject({ type: 'error', id: 3, kernel: 'mix', message: 'worker not initialised' });
  });
});
