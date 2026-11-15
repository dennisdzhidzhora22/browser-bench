// Points.svelte rendered on the server (the vitest config has no Svelte plugin, so a throwaway Vite server compiles
// the component). Checks the reference columns: like for like only, so a partial component and a partial total show
// a dash. Nothing here asserts on speed.
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reference } from '../../src/lib/scoring/score.ts';
import { SCORE_VERSION } from '../../src/lib/scoring/constants.ts';
import { buildRecord } from '../../src/lib/store/record.ts';
import type { RunRecord } from '../../src/lib/store/schema.ts';
import { completeView, outcome, SYSTEM } from './store-support.ts';
import { cpuKernels } from '../../src/lib/bench/cpu/index.ts';

let server: ViteDevServer;
let Points: unknown;
let refs: Reference[];
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
  Points = (await server.ssrLoadModule('/src/ui/Points.svelte')).default;
  render = (await server.ssrLoadModule('svelte/server')).render;
  refs = (await server.ssrLoadModule('/src/lib/scoring/score.ts')).references as Reference[];
}, 60_000);

afterAll(async () => {
  refs?.splice(0);
  await server?.close();
});

const REF: Reference = {
  name: 'Ref PC',
  scoreVersion: SCORE_VERSION,
  results: {},
  points: { 'cpu-single': 4321, 'cpu-multi': 4322, memory: 4323, gpu: 4324, storage: 4325, total: 4326 },
};

function html(run: RunRecord): string {
  return render(Points as never, { props: { run, saved: false } }).body;
}
/** The cells of the row with this testid (or the total row), without markup. */
function cells(body: string, testid: string): string[] {
  const row = testid === 'total' ? /<tr class="total[^"]*"[^>]*>([\s\S]*?)<\/tr>/.exec(body) : new RegExp(`<tr[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</tr>`).exec(body);
  if (!row) throw new Error(`no row ${testid}`);
  return [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}

describe('Points: reference column', () => {
  it('a complete run shows the reference points beside its own, and the reference total', () => {
    refs.splice(0, refs.length, REF);
    const run = buildRecord(completeView(), ['cpu-single', 'cpu-multi', 'memory', 'gpu', 'storage'], 'quick', 'standard', SYSTEM);
    const b = html(run);
    expect(b).toContain('Ref PC');
    expect(cells(b, 'points-cpu-single')).toEqual(['CPU — single core', '1000', '4321']);
    expect(cells(b, 'points-memory')[2]).toBe('4323');
    expect(cells(b, 'total')).toEqual(['Total', '1000', '4326']);
  });

  it('a partial component shows a dash in the reference column; the others still show theirs', () => {
    refs.splice(0, refs.length, REF);
    const v = completeView();
    v.outcomes[0] = outcome(cpuKernels[0]!, undefined, { valid: false, error: 'bad' });
    const run = buildRecord(v, ['cpu-single', 'memory'], 'quick', 'standard', SYSTEM);
    const b = html(run);
    expect(run.components[0]!.partial).toBe(true);
    expect(cells(b, 'points-cpu-single')[2]).toBe('—');
    expect(cells(b, 'points-memory')[2]).toBe('4323');
  });

  it('a partial total (not every component ran) shows a dash in the reference column', () => {
    refs.splice(0, refs.length, REF);
    const run = buildRecord(completeView(), ['cpu-single', 'memory'], 'quick', 'standard', SYSTEM);
    expect(run.partial).toBe(true);
    const total = cells(html(run), 'total');
    expect(total[1]).toBe('1000 partial');
    expect(total[2]).toBe('—');
  });

  it('a component that earns no points (note) shows a dash too', () => {
    refs.splice(0, refs.length, REF);
    const v = completeView();
    v.storagePlan = { ok: true, fileBytes: 16 * 1024 * 1024, scaled: true };
    const run = buildRecord(v, ['cpu-single', 'storage'], 'quick', 'standard', SYSTEM);
    expect(cells(html(run), 'points-storage')[2]).toBe('—');
  });

  it('another scoreVersion: no reference column at all, and a not-comparable notice', () => {
    refs.splice(0, refs.length, REF);
    const run = { ...buildRecord(completeView(), ['cpu-single'], 'quick', 'standard', SYSTEM), scoreVersion: SCORE_VERSION + 1 };
    const b = html(run);
    expect(b).not.toContain('Ref PC');
    expect(b).toContain('data-testid="not-comparable"');
    expect(b).toContain(`score v${SCORE_VERSION + 1}`);
  });

  it('no reference entries: no extra column', () => {
    refs.splice(0, refs.length);
    const b = html(buildRecord(completeView(), ['cpu-single'], 'quick', 'standard', SYSTEM));
    expect(b).not.toContain('Ref PC');
    expect(cells(b, 'points-cpu-single')).toHaveLength(2);
  });

  it('smoke: "smoke: no points" and no table', () => {
    refs.splice(0, refs.length, REF);
    const b = html(buildRecord(completeView(), ['cpu-single'], 'quick', 'smoke', SYSTEM));
    expect(b).toContain('smoke: no points');
    expect(b).not.toContain('<table');
  });
});
