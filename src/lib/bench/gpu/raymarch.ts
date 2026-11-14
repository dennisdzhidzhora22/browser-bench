// The ray-march scene shared by gpu_fragment (WGSL) and gpu_fragment_gl (GLSL),
// plus a JS mirror of the same math used to validate the rendered image.
//
// Scene: ground plane, two spheres blended with a smooth minimum, a rounded
// box and a torus, lit by one sun (soft shadows) plus a sky ambient term, with
// distance fog. Every function the shader uses is + - * / sqrt min max clamp
// abs, so the f32 GPU result and the f64 JS mirror differ only by rounding (no
// sin/exp/pow, whose GPU approximations vary by vendor).
//
// Keep the three copies (WGSL, GLSL, JS) identical in constants and order of
// operations. Pixel (x, y) is counted from the top-left corner in all three.

/** Max ray-march steps per pixel (the work per pixel is bounded by this). */
export const MARCH_STEPS = 96;
const SHADOW_STEPS = 32;

/** Image height for width `w` (16:9). */
export function fragmentHeight(w: number): number {
  return Math.max(1, Math.round((w * 9) / 16));
}

/** Mpixels per frame. */
export function fragmentWork(w: number): number {
  return (w * fragmentHeight(w)) / 1e6;
}

export const WGSL_SCENE = /* wgsl */ `
struct U { res: vec2f, pad: vec2f }
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn sdBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

fn map(p: vec3f) -> vec2f {
  var res = vec2f(p.y, 0.0);
  let blob = smin(length(p - vec3f(-1.2, 0.75, 0.0)) - 0.75, length(p - vec3f(-0.5, 0.3, 0.6)) - 0.3, 0.25);
  if (blob < res.x) { res = vec2f(blob, 1.0); }
  let bx = sdBox(p - vec3f(1.15, 0.55, -0.1), vec3f(0.45, 0.45, 0.45), 0.1);
  if (bx < res.x) { res = vec2f(bx, 2.0); }
  let q = p - vec3f(0.35, 0.22, 1.1);
  let tor = length(vec2f(length(q.xz) - 0.5, q.y)) - 0.22;
  if (tor < res.x) { res = vec2f(tor, 3.0); }
  return res;
}

fn normalAt(p: vec3f) -> vec3f {
  let e = 0.001;
  return normalize(vec3f(
    map(p + vec3f(e, 0.0, 0.0)).x - map(p - vec3f(e, 0.0, 0.0)).x,
    map(p + vec3f(0.0, e, 0.0)).x - map(p - vec3f(0.0, e, 0.0)).x,
    map(p + vec3f(0.0, 0.0, e)).x - map(p - vec3f(0.0, 0.0, e)).x));
}

fn shadow(ro: vec3f, rd: vec3f) -> f32 {
  var res = 1.0;
  var t = 0.02;
  for (var i = 0; i < ${SHADOW_STEPS}; i++) {
    let h = map(ro + rd * t).x;
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.02, 0.4);
    if (res < 0.001 || t > 6.0) { break; }
  }
  return clamp(res, 0.0, 1.0);
}

fn albedo(m: f32) -> vec3f {
  if (m < 0.5) { return vec3f(0.55, 0.5, 0.45); }
  if (m < 1.5) { return vec3f(0.85, 0.3, 0.2); }
  if (m < 2.5) { return vec3f(0.2, 0.45, 0.85); }
  return vec3f(0.9, 0.75, 0.25);
}

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fc.x - 0.5 * u.res.x, 0.5 * u.res.y - fc.y) / u.res.y;
  let ro = vec3f(0.0, 1.5, 4.5);
  let ww = normalize(vec3f(0.0, 0.5, 0.0) - ro);
  let uu = normalize(cross(ww, vec3f(0.0, 1.0, 0.0)));
  let vv = cross(uu, ww);
  let rd = normalize(uv.x * uu + uv.y * vv + 1.6 * ww);
  let sky = mix(vec3f(0.75, 0.8, 0.9), vec3f(0.3, 0.5, 0.85), clamp(rd.y * 2.0, 0.0, 1.0));
  var t = 0.0;
  var m = -1.0;
  for (var i = 0; i < ${MARCH_STEPS}; i++) {
    let h = map(ro + rd * t);
    if (h.x < 0.0002 + 0.0005 * t) { m = h.y; break; }
    t += h.x;
    if (t > 30.0) { break; }
  }
  var col = sky;
  if (m >= 0.0) {
    let p = ro + rd * t;
    let n = normalAt(p);
    let l = normalize(vec3f(0.5, 0.8, 0.3));
    let dif = clamp(dot(n, l), 0.0, 1.0) * shadow(p + n * 0.002, l);
    let amb = 0.5 + 0.5 * n.y;
    let c = albedo(m) * (amb * vec3f(0.22, 0.28, 0.38) + dif * vec3f(1.1, 1.0, 0.85));
    let f = 1.0 / (1.0 + 0.003 * t * t);
    col = mix(sky, c, f);
  }
  return vec4f(sqrt(clamp(col, vec3f(0.0), vec3f(1.0))), 1.0);
}
`;

export const GLSL_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const GLSL_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
out vec4 outColor;

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

vec2 map(vec3 p) {
  vec2 res = vec2(p.y, 0.0);
  float blob = smin(length(p - vec3(-1.2, 0.75, 0.0)) - 0.75, length(p - vec3(-0.5, 0.3, 0.6)) - 0.3, 0.25);
  if (blob < res.x) { res = vec2(blob, 1.0); }
  float bx = sdBox(p - vec3(1.15, 0.55, -0.1), vec3(0.45, 0.45, 0.45), 0.1);
  if (bx < res.x) { res = vec2(bx, 2.0); }
  vec3 q = p - vec3(0.35, 0.22, 1.1);
  float tor = length(vec2(length(q.xz) - 0.5, q.y)) - 0.22;
  if (tor < res.x) { res = vec2(tor, 3.0); }
  return res;
}

vec3 normalAt(vec3 p) {
  float e = 0.001;
  return normalize(vec3(
    map(p + vec3(e, 0.0, 0.0)).x - map(p - vec3(e, 0.0, 0.0)).x,
    map(p + vec3(0.0, e, 0.0)).x - map(p - vec3(0.0, e, 0.0)).x,
    map(p + vec3(0.0, 0.0, e)).x - map(p - vec3(0.0, 0.0, e)).x));
}

float shadow(vec3 ro, vec3 rd) {
  float res = 1.0;
  float t = 0.02;
  for (int i = 0; i < ${SHADOW_STEPS}; i++) {
    float h = map(ro + rd * t).x;
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.02, 0.4);
    if (res < 0.001 || t > 6.0) { break; }
  }
  return clamp(res, 0.0, 1.0);
}

vec3 albedo(float m) {
  if (m < 0.5) { return vec3(0.55, 0.5, 0.45); }
  if (m < 1.5) { return vec3(0.85, 0.3, 0.2); }
  if (m < 2.5) { return vec3(0.2, 0.45, 0.85); }
  return vec3(0.9, 0.75, 0.25);
}

void main() {
  // gl_FragCoord.y counts from the bottom; flip so y counts from the top as in WGSL.
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = vec2(fc.x - 0.5 * uRes.x, 0.5 * uRes.y - fc.y) / uRes.y;
  vec3 ro = vec3(0.0, 1.5, 4.5);
  vec3 ww = normalize(vec3(0.0, 0.5, 0.0) - ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.6 * ww);
  vec3 sky = mix(vec3(0.75, 0.8, 0.9), vec3(0.3, 0.5, 0.85), clamp(rd.y * 2.0, 0.0, 1.0));
  float t = 0.0;
  float m = -1.0;
  for (int i = 0; i < ${MARCH_STEPS}; i++) {
    vec2 h = map(ro + rd * t);
    if (h.x < 0.0002 + 0.0005 * t) { m = h.y; break; }
    t += h.x;
    if (t > 30.0) { break; }
  }
  vec3 col = sky;
  if (m >= 0.0) {
    vec3 p = ro + rd * t;
    vec3 n = normalAt(p);
    vec3 l = normalize(vec3(0.5, 0.8, 0.3));
    float dif = clamp(dot(n, l), 0.0, 1.0) * shadow(p + n * 0.002, l);
    float amb = 0.5 + 0.5 * n.y;
    vec3 c = albedo(m) * (amb * vec3(0.22, 0.28, 0.38) + dif * vec3(1.1, 1.0, 0.85));
    float f = 1.0 / (1.0 + 0.003 * t * t);
    col = mix(sky, c, f);
  }
  outColor = vec4(sqrt(clamp(col, vec3(0.0), vec3(1.0))), 1.0);
}
`;

// ---- JS mirror (f64) -------------------------------------------------------

type V3 = [number, number, number];

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const mix = (a: number, b: number, h: number): number => a * (1 - h) + b * h;
const len3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}

/** Returns [distance, material]. */
function map(x: number, y: number, z: number): [number, number] {
  let d = y;
  let m = 0;
  const blob = smin(len3(x + 1.2, y - 0.75, z) - 0.75, len3(x + 0.5, y - 0.3, z - 0.6) - 0.3, 0.25);
  if (blob < d) [d, m] = [blob, 1];
  const qx = Math.abs(x - 1.15) - 0.45;
  const qy = Math.abs(y - 0.55) - 0.45;
  const qz = Math.abs(z + 0.1) - 0.45;
  const bx =
    len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
    Math.min(Math.max(qx, Math.max(qy, qz)), 0) -
    0.1;
  if (bx < d) [d, m] = [bx, 2];
  const tx = x - 0.35;
  const ty = y - 0.22;
  const tz = z - 1.1;
  const tor = Math.hypot(Math.hypot(tx, tz) - 0.5, ty) - 0.22;
  if (tor < d) [d, m] = [tor, 3];
  return [d, m];
}

const dist = (x: number, y: number, z: number): number => map(x, y, z)[0];

function normalize(v: V3): V3 {
  const l = len3(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function shadow(o: V3, d: V3): number {
  let res = 1;
  let t = 0.02;
  for (let i = 0; i < SHADOW_STEPS; i++) {
    const h = dist(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
    res = Math.min(res, (8 * h) / t);
    t += clamp(h, 0.02, 0.4);
    if (res < 0.001 || t > 6) break;
  }
  return clamp(res, 0, 1);
}

const ALBEDO: V3[] = [
  [0.55, 0.5, 0.45],
  [0.85, 0.3, 0.2],
  [0.2, 0.45, 0.85],
  [0.9, 0.75, 0.25],
];

export interface MirrorPixel {
  /** Colour in 0..255, not rounded. */
  rgb: V3;
  /** Material hit, or -1 for sky. */
  mat: number;
  /** March steps taken (MARCH_STEPS = did not converge). */
  steps: number;
}

/** Shade the point (fx, fy) in pixel units from the top-left (pixel centres at +0.5). */
export function shadeMirror(fx: number, fy: number, w: number, h: number): MirrorPixel {
  const ux = (fx - 0.5 * w) / h;
  const uy = (0.5 * h - fy) / h;
  const ro: V3 = [0, 1.5, 4.5];
  const ww = normalize([0 - ro[0], 0.5 - ro[1], 0 - ro[2]]);
  // cross(ww, (0,1,0)) = (-ww.z, 0, ww.x)
  const uu = normalize([-ww[2], 0, ww[0]]);
  const vv: V3 = [
    uu[1] * ww[2] - uu[2] * ww[1],
    uu[2] * ww[0] - uu[0] * ww[2],
    uu[0] * ww[1] - uu[1] * ww[0],
  ];
  const rd = normalize([
    ux * uu[0] + uy * vv[0] + 1.6 * ww[0],
    ux * uu[1] + uy * vv[1] + 1.6 * ww[1],
    ux * uu[2] + uy * vv[2] + 1.6 * ww[2],
  ]);
  const s = clamp(rd[1] * 2, 0, 1);
  const sky: V3 = [mix(0.75, 0.3, s), mix(0.8, 0.5, s), mix(0.9, 0.85, s)];
  let t = 0;
  let m = -1;
  let steps = 0;
  for (; steps < MARCH_STEPS; steps++) {
    const [d, mm] = map(ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t);
    if (d < 0.0002 + 0.0005 * t) {
      m = mm;
      break;
    }
    t += d;
    if (t > 30) break;
  }
  let col = sky;
  if (m >= 0) {
    const p: V3 = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const e = 0.001;
    const n = normalize([
      dist(p[0] + e, p[1], p[2]) - dist(p[0] - e, p[1], p[2]),
      dist(p[0], p[1] + e, p[2]) - dist(p[0], p[1] - e, p[2]),
      dist(p[0], p[1], p[2] + e) - dist(p[0], p[1], p[2] - e),
    ]);
    const l = normalize([0.5, 0.8, 0.3]);
    const dot = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
    const sh = shadow([p[0] + n[0] * 0.002, p[1] + n[1] * 0.002, p[2] + n[2] * 0.002], l);
    const dif = clamp(dot, 0, 1) * sh;
    const amb = 0.5 + 0.5 * n[1];
    const alb = ALBEDO[m] ?? ALBEDO[0]!;
    const amb3: V3 = [0.22, 0.28, 0.38];
    const sun3: V3 = [1.1, 1.0, 0.85];
    const f = 1 / (1 + 0.003 * t * t);
    col = [0, 1, 2].map((i) => mix(sky[i]!, alb[i]! * (amb * amb3[i]! + dif * sun3[i]!), f)) as V3;
  }
  return { rgb: col.map((c) => Math.sqrt(clamp(c, 0, 1)) * 255) as V3, mat: m, steps };
}

// ---- Validation --------------------------------------------------------------

/**
 * Per-channel tolerance, in 8-bit steps. The GPU computes in f32 and the mirror
 * in f64; on the chosen pixels (see pickPixels) the f32 rounding in the march,
 * normal and shadow math moves the colour by well under one step, the 8-bit
 * store rounds by up to half a step, and WGSL/GLSL allow a few ULP of error in
 * sqrt and division. 3 steps covers all of that with margin, while any real
 * mistake (wrong scene, wrong lighting, black or stale output) is off by far more.
 */
export const FRAGMENT_TOLERANCE = 3;

/** Number of pixels compared against the mirror. */
const CHECK_PIXELS = 8;
/** Probe offset (pixels) and max change (8-bit steps) for the smoothness test. */
const PROBE = 0.25;
const MAX_LOCAL_CHANGE = 4;

export interface CheckPixel {
  x: number;
  y: number;
  rgb: V3;
}

/**
 * Pick pixels in smooth regions: the mirror gives the same material at the
 * pixel centre and at four points PROBE pixels away, the colour changes by at
 * most MAX_LOCAL_CHANGE there (no silhouette or shadow edge nearby), and the
 * march converged well before MARCH_STEPS (or clearly escaped to the sky), so
 * f32 rounding cannot flip the outcome. Mostly object/ground pixels, some sky.
 */
export function pickPixels(w: number, h: number): CheckPixel[] {
  const hits: CheckPixel[] = [];
  const skies: CheckPixel[] = [];
  const cols = 16;
  const rows = 9;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = Math.min(w - 1, Math.floor(((i + 0.5) * w) / cols));
      const y = Math.min(h - 1, Math.floor(((j + 0.5) * h) / rows));
      const c = shadeMirror(x + 0.5, y + 0.5, w, h);
      if (c.mat >= 0 && c.steps > (MARCH_STEPS * 2) / 3) continue;
      if (c.mat < 0 && c.steps >= MARCH_STEPS) continue;
      let smooth = true;
      for (const [dx, dy] of [
        [PROBE, 0],
        [-PROBE, 0],
        [0, PROBE],
        [0, -PROBE],
      ] as const) {
        const n = shadeMirror(x + 0.5 + dx, y + 0.5 + dy, w, h);
        const change = Math.max(...n.rgb.map((v, k) => Math.abs(v - c.rgb[k]!)));
        if (n.mat !== c.mat || change > MAX_LOCAL_CHANGE) smooth = false;
      }
      if (smooth) (c.mat >= 0 ? hits : skies).push({ x, y, rgb: c.rgb });
    }
  }
  const spread = (list: CheckPixel[], n: number): CheckPixel[] =>
    list.length <= n
      ? list
      : Array.from({ length: n }, (_, k) => list[Math.floor(((k + 0.5) * list.length) / n)]!);
  const nh = Math.min(hits.length, CHECK_PIXELS - Math.min(2, skies.length));
  return [...spread(hits, nh), ...spread(skies, CHECK_PIXELS - nh)];
}

/**
 * Compare the rendered image with the mirror. `offset(x, y)` returns the RGBA
 * byte offset of pixel (x, y) (top-left origin) in `px`.
 */
export function checkFragmentImage(
  w: number,
  h: number,
  px: Uint8Array,
  offset: (x: number, y: number) => number,
): { ok: boolean; detail?: string } {
  const picked = pickPixels(w, h);
  if (picked.length < 4) {
    return { ok: false, detail: `only ${picked.length} smooth pixels found at ${w}x${h}` };
  }
  for (const p of picked) {
    const o = offset(p.x, p.y);
    const got = [px[o]!, px[o + 1]!, px[o + 2]!];
    const want = p.rgb.map((v) => Math.round(v));
    if (got.some((g, k) => Math.abs(g - want[k]!) > FRAGMENT_TOLERANCE)) {
      return {
        ok: false,
        detail: `pixel (${p.x},${p.y}) is ${got.join(',')}, expected ${want.join(',')} (±${FRAGMENT_TOLERANCE})`,
      };
    }
  }
  // The image must not be uniform (e.g. one clear colour that happens to match).
  let lo = 255;
  let hi = 0;
  for (let j = 0; j < 9; j++) {
    for (let i = 0; i < 16; i++) {
      const o = offset(Math.floor(((i + 0.5) * w) / 16), Math.floor(((j + 0.5) * h) / 9));
      for (let k = 0; k < 3; k++) {
        lo = Math.min(lo, px[o + k]!);
        hi = Math.max(hi, px[o + k]!);
      }
    }
  }
  if (hi - lo < 32) return { ok: false, detail: `image is nearly uniform (channel range ${lo}..${hi})` };
  return { ok: true };
}
