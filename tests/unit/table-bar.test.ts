// Table.svelte "vs. ref" bar column, rendered on the server (same approach as table-ui.test.ts).
// The bar starts at the middle (the reference): right when this result is better, left when worse, half the
// cell is 2x; "better" means higher, except for units in LOWER_IS_BETTER (ns). Nothing here asserts on speed.
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reference } from '../../src/lib/scoring/score.ts';
import type { KernelRecord } from '../../src/lib/store/schema.ts';

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

const REF = (name = 'Owner PC'): Reference => ({ name, scoreVersion: 1, results: {}, points: {} });

const kernel = (over: Partial<KernelRecord> = {}): KernelRecord => ({
  key: 'k',
  unit: 'MB/s',
  value: 100,
  valid: true,
  noisy: false,
  hidden: false,
  ...over,
});

interface Bar {
  down: boolean;
  left: number;
  width: number;
  title: string;
}

/** Renders one row; returns the table's html, its headers and the bar (undefined when the row has none). */
function draw(k: KernelRecord, refv: number | undefined, refs: Reference[] | undefined = [REF()], withRefv = true) {
  const body = render(Table as never, {
    props: {
      rows: [k],
      cols: [{ head: 'Value', cell: () => 'x' }],
      rowid: () => 'row',
      refs,
      refAt: 1,
      ref: () => 'r',
      ...(withRefv ? { refv: () => refv } : {}),
    },
  }).body;
  const heads = [...body.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map((m) => m[1]!.trim());
  const cell = /<td class="rel"([^>]*)>([\s\S]*?)<\/td>/.exec(body);
  const i = cell ? /<i([^>]*)><\/i>/.exec(cell[2]!) : null;
  let bar: Bar | undefined;
  if (i) {
    const attrs = i[1]!;
    const style = /style="([^"]*)"/.exec(attrs)?.[1] ?? '';
    bar = {
      down: /class="[^"]*\bdown\b/.test(attrs),
      left: parseFloat(/left:\s*([\d.]+)%/.exec(style)?.[1] ?? 'NaN'),
      width: parseFloat(/width:\s*([\d.]+)%/.exec(style)?.[1] ?? 'NaN'),
      title: /title="([^"]*)"/.exec(cell![1]!)?.[1] ?? '',
    };
  }
  return { body, heads, hasColumn: !!cell, bar };
}

describe('Table: vs. ref bar', () => {
  it('a higher-is-better result above the reference grows right from the middle', () => {
    const { heads, bar } = draw(kernel({ value: 200 }), 100); // exactly 2x
    expect(heads).toEqual(['Value', 'Owner PC', 'vs. ref', 'Check']);
    expect(bar).toMatchObject({ down: false, left: 50, width: 50 });
    expect(bar!.title).toBe('+100.0 % vs. Owner PC');
  });

  it('a higher-is-better result below the reference grows left, ending at the middle', () => {
    const half = draw(kernel({ value: 50 }), 100).bar!; // 0.5x: the full half cell
    expect(half).toMatchObject({ down: true, left: 0, width: 50 });
    expect(half.title).toBe('−50.0 % vs. Owner PC');
    const some = draw(kernel({ value: 100 * Math.SQRT1_2 }), 100).bar!; // a quarter of the cell
    expect(some.down).toBe(true);
    expect(some.width).toBeCloseTo(25, 6);
    expect(some.left).toBeCloseTo(25, 6); // left + width = 50: the bar ends at the reference tick
  });

  it('an equal result has a zero-width bar at the middle (not down)', () => {
    const { bar } = draw(kernel({ value: 100 }), 100);
    expect(bar).toMatchObject({ down: false, left: 50, width: 0 });
  });

  it('a lower-is-better unit (ns) is inverted: faster (smaller) than the reference grows right', () => {
    const better = draw(kernel({ unit: 'ns', value: 5 }), 10).bar!; // half the latency = 2x as good
    expect(better.down).toBe(false);
    expect(better.left).toBe(50);
    expect(better.width).toBe(50);
    expect(better.title).toContain('+100.0 %');
  });

  it('a lower-is-better unit slower (larger) than the reference grows left', () => {
    const worse = draw(kernel({ unit: 'ns', value: 10 * Math.SQRT2 }), 10).bar!; // sqrt(2)x the latency
    expect(worse.down).toBe(true);
    expect(worse.width).toBeCloseTo(25, 6);
    expect(worse.left).toBeCloseTo(25, 6);
    expect(worse.title).toContain('−29.3 %');
    const twice = draw(kernel({ unit: 'ns', value: 20 }), 10).bar!; // twice the latency: the full half cell
    expect(twice).toMatchObject({ down: true, left: 0, width: 50 });
  });

  it('the same numbers point opposite ways for ns and for a throughput unit', () => {
    expect(draw(kernel({ unit: 'ns', value: 20 }), 10).bar!.down).toBe(true);
    expect(draw(kernel({ unit: 'MB/s', value: 20 }), 10).bar!.down).toBe(false);
  });

  it('the width is capped at half the cell for a huge difference, either way', () => {
    const up = draw(kernel({ value: 1e6 }), 1).bar!;
    expect(up).toMatchObject({ down: false, left: 50, width: 50 });
    const down = draw(kernel({ value: 1 }), 1e6).bar!;
    expect(down.down).toBe(true);
    expect(down.width).toBe(50);
    expect(down.left).toBe(0);
    for (const b of [up, down]) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(100);
    }
  });

  it('an invalid row has the column but no bar', () => {
    const r = draw(kernel({ valid: false, value: null, error: 'boom' }), 100);
    expect(r.hasColumn).toBe(true);
    expect(r.bar).toBeUndefined();
  });

  it('a hidden (invalid) row with a leftover value has no bar', () => {
    const r = draw(kernel({ valid: false, hidden: true, value: 80 }), 100);
    expect(r.hasColumn).toBe(true);
    expect(r.bar).toBeUndefined();
  });

  it('a row with no reference value (refv undefined or 0) has the column but no bar', () => {
    expect(draw(kernel(), undefined)).toMatchObject({ hasColumn: true, bar: undefined });
    expect(draw(kernel(), 0)).toMatchObject({ hasColumn: true, bar: undefined });
  });

  it('a row whose own value is 0 or null has no bar', () => {
    expect(draw(kernel({ value: 0 }), 100).bar).toBeUndefined();
    expect(draw(kernel({ value: null }), 100).bar).toBeUndefined();
  });

  it('no refv prop: no vs. ref column at all, even with a reference column', () => {
    const r = draw(kernel(), 100, [REF()], false);
    expect(r.hasColumn).toBe(false);
    expect(r.heads).toEqual(['Value', 'Owner PC', 'Check']);
  });

  it('no references: neither the reference column nor the bar column', () => {
    const r = draw(kernel(), 100, []);
    expect(r.hasColumn).toBe(false);
    expect(r.heads).toEqual(['Value', 'Check']);
  });

  it('with two references the bar uses the first one', () => {
    const r = draw(kernel({ value: 200 }), 100, [REF('First'), REF('Second')]);
    expect(r.heads).toEqual(['Value', 'First', 'Second', 'vs. ref', 'Check']);
    expect(r.bar!.title).toContain('vs. First');
  });
});
