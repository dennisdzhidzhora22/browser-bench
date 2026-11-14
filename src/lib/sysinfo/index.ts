// System info (docs/SPEC.md, 3.6). Collected once, before a run; not scored.
//
// Refresh rate is not measured: no result depends on it (GPU tests render
// off-screen) and measuring it would add about half a second of
// requestAnimationFrame counting before every run.

export interface SystemInfo {
  /** e.g. "Google Chrome", "Microsoft Edge"; from userAgentData, else the UA string. */
  browser: string;
  /** Full version when the browser gives it (e.g. "142.0.7444.60"). */
  version: string;
  ua: string;
  platform?: string;
  /** navigator.hardwareConcurrency: logical cores. */
  cores: number;
  /** navigator.deviceMemory: GB, coarse and capped (Chrome reports at most 8 or 32). */
  deviceMemory?: number;
  /** CSS pixels and device pixel ratio, e.g. "2560x1440@1.5". */
  screen: string;
  isolated: boolean;
  /** Labels of the GPUs tested, when the GPU component ran (filled in after the run). */
  gpu?: string[];
}

interface UaData {
  platform?: string;
  getHighEntropyValues?(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }>;
  brands?: { brand: string; version: string }[];
}

/** Brand and version from a UA string (Edge says "Edg/", Chrome "Chrome/"). */
export function parseUa(ua: string): { browser: string; version: string } {
  for (const [re, browser] of [
    [/Edg\/([\d.]+)/, 'Microsoft Edge'],
    [/Chrome\/([\d.]+)/, 'Google Chrome'],
  ] as const) {
    const m = re.exec(ua);
    if (m) return { browser, version: m[1]! };
  }
  return { browser: 'unknown', version: '' };
}

export async function collectSystemInfo(): Promise<SystemInfo> {
  const nav = navigator as Navigator & { userAgentData?: UaData; deviceMemory?: number };
  const ua = nav.userAgent;
  let { browser, version } = parseUa(ua);
  try {
    const d = nav.userAgentData;
    const list = (await d?.getHighEntropyValues?.(['fullVersionList']))?.fullVersionList ?? d?.brands;
    // Skip GREASE brands ("Not A;Brand") and prefer the product over "Chromium".
    const real = list?.filter((b) => !/not.?a.?brand/i.test(b.brand));
    const pick = real?.find((b) => b.brand !== 'Chromium') ?? real?.[0];
    if (pick) ({ brand: browser, version } = pick);
  } catch {
    // keep the UA string's answer
  }
  const platform = nav.userAgentData?.platform;
  return {
    browser,
    version,
    ua,
    ...(platform ? { platform } : {}),
    cores: nav.hardwareConcurrency || 1,
    ...(nav.deviceMemory ? { deviceMemory: nav.deviceMemory } : {}),
    screen: `${screen.width}x${screen.height}@${Math.round((globalThis.devicePixelRatio || 1) * 100) / 100}`,
    isolated: globalThis.crossOriginIsolated === true,
  };
}
