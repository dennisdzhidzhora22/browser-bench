// Table.svelte rendered on the server (the vitest config has no Svelte plugin, so a throwaway Vite server compiles
// the component). Checks the Check column: a failed output check outranks "hidden" in the status text and makes
// data-ok false. Nothing here asserts on speed.
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';
import { kernelRecord } from '../../src/lib/store/record.ts';
import type { KernelRecord } from '../../src/lib/store/schema.ts';
import { outcome } from './store-support.ts';

let server: ViteDevServer;
let Table: unknown;
let render: (c: never, o: { props: object }) => { body: string };

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [svelte()],
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    logLevel: 'silent',
  });
  Table = (await server.ssrLoadModule('/src/ui/Table.svelte')).default;
  render = (await server.ssrLoadModule('svelte/server')).render;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/** The Check cell of a table with this one kernel: its status text and its data-* attributes. */
function check(k: KernelRecord): { text: string; ok: string | undefined; valid: string | undefined } {
  const body = render(Table as never, {
    props: { rows: [k], cols: [{ head: 'Value', cell: () => 'x' }], rowid: () => 'row' },
  }).body;
  const m = /<td[^>]*data-testid="checksum"[^>]*>([\s\S]*?)<\/td>/.exec(body);
  if (!m) throw new Error(`no checksum cell in: ${body}`);
  const attr = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(m[0].slice(0, m[0].indexOf('>')))?.[1];
  return { text: m[1]!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), ok: attr('data-ok'), valid: attr('data-valid') };
}

const def = cpuKernels[0]!;
const MSG = 'output check failed: wrong checksum';

describe('Table: the Check column', () => {
  it('a good result says ok, data-ok true', () => {
    expect(check(kernelRecord(outcome(def, 100)))).toMatchObject({ text: 'ok', ok: 'true', valid: 'true' });
  });

  it('a noisy but valid result says noisy, data-ok true', () => {
    expect(check(kernelRecord(outcome(def, 100, { noisy: true })))).toMatchObject({ text: 'noisy', ok: 'true' });
  });

  it('hidden with a passing check says hidden, data-ok true (not a failure of the kernel)', () => {
    const k = kernelRecord(outcome(def, 100, { valid: false, hidden: true, error: 'tab was hidden' }));
    expect(check(k)).toMatchObject({ text: 'hidden', ok: 'true', valid: 'false' });
  });

  it('a failed check shows its error, data-ok false', () => {
    const k = kernelRecord(outcome(def, 100, { valid: false, checksumOk: false, error: MSG }));
    expect(check(k)).toMatchObject({ text: MSG, ok: 'false', valid: 'false' });
  });

  it('hidden AND a failed check: the status shows the error, not "hidden", and data-ok is false', () => {
    const k = kernelRecord(outcome(def, 100, { valid: false, hidden: true, checksumOk: false, error: MSG }));
    expect(k).toMatchObject({ hidden: true, checksumOk: false });
    const c = check(k);
    expect(c.text).toBe(MSG);
    expect(c.text).not.toBe('hidden');
    expect(c.ok).toBe('false');
  });

  it('a failed check with no message still says failed, never "hidden" or ok', () => {
    const k = kernelRecord(outcome(def, 100, { valid: false, hidden: true, checksumOk: false }));
    expect(check(k)).toMatchObject({ text: 'failed', ok: 'false' });
  });

  it('an older record without checksumOk behaves as before: hidden says hidden, invalid shows its error', () => {
    const hidden = kernelRecord(outcome(def, 100, { valid: false, hidden: true }));
    expect('checksumOk' in hidden).toBe(false);
    expect(check(hidden)).toMatchObject({ text: 'hidden', ok: 'true' });
    expect(check(kernelRecord(outcome(def, 100, { valid: false, error: 'boom' })))).toMatchObject({ text: 'boom', ok: 'false' });
  });
});
