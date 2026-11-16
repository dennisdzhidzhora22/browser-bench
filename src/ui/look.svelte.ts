// Skin and light/dark choice (docs/SPEC.md, section 12, "M8 polish").
//
// index.html's inline script sets <html data-skin data-theme> before first
// paint from the same two localStorage keys, so there is no flash. This module
// only changes them afterwards. `data-theme` is always the resolved theme
// (light or dark); "auto" follows the OS through one media-query listener.
// Charts read their colours from CSS variables and redraw when `look.v` changes.

export const SKINS = [
  ['clean', 'A · Clean'],
  ['terminal', 'B · Terminal'],
  ['vivid', 'C · Vivid'],
  ['minimal', 'D · Minimal'],
] as const;
export type Skin = (typeof SKINS)[number][0];
export type ThemeChoice = 'auto' | 'light' | 'dark';

const SKIN_KEY = 'browser-bench:skin';
const THEME_KEY = 'browser-bench:theme';
const root = document.documentElement;
const os = matchMedia('(prefers-color-scheme: dark)');

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const savedSkin = read(SKIN_KEY);
const savedTheme = read(THEME_KEY);

export const look = $state({
  skin: (SKINS.some(([id]) => id === savedSkin) ? savedSkin : 'minimal') as Skin,
  theme: (savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'auto') as ThemeChoice,
  /** Bumped on every applied change: charts read it so they redraw. */
  v: 0,
  /** True during a run: an OS theme change waits until the run ends (no DOM writes mid-test). */
  frozen: false,
  pending: false,
});

function apply() {
  if (look.frozen) {
    look.pending = true;
    return;
  }
  look.pending = false;
  root.dataset['skin'] = look.skin;
  root.dataset['theme'] = look.theme === 'auto' ? (os.matches ? 'dark' : 'light') : look.theme;
  look.v++;
}

os.addEventListener('change', () => {
  if (look.theme === 'auto') apply();
});

export function setLook(skin: Skin, theme: ThemeChoice) {
  look.skin = skin;
  look.theme = theme;
  try {
    localStorage.setItem(SKIN_KEY, skin);
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // blocked storage: the choice lasts for this page only
  }
  apply();
}

/** Run start / end: hold OS theme changes while measuring, apply them after. */
export function freezeLook(on: boolean) {
  look.frozen = on;
  if (!on && look.pending) apply();
}

/** Reads the colours a chart needs, once per draw (never during measurement). */
export function chartColors(el: Element) {
  const s = getComputedStyle(el);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    text: v('--text'),
    muted: v('--muted'),
    line: v('--line'),
    bg: v('--bg'),
    plot: v('--plot'),
    ref: v('--muted'),
    series: [1, 2, 3, 4, 5].map((i) => v(`--s${i}`)),
    font: `11px ${s.fontFamily}`,
  };
}
