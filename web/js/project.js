// Project model: shows, layers, keyframes, and the interpolation that turns a
// time in milliseconds into a concrete draw state for every layer.

import { shapeDefaults } from './shapes.js';

export const PROJECT_VERSION = 2;

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s.slice(0, 6).padEnd(6, '0'), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// ---------------------------------------------------------------------------
// easing
// ---------------------------------------------------------------------------

export const EASES = {
  linear: (t) => t,
  hold: () => 0,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  'sine-in': (t) => 1 - Math.cos((t * Math.PI) / 2),
  'sine-out': (t) => Math.sin((t * Math.PI) / 2),
  'sine-in-out': (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  'expo-in': (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  'expo-out': (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  'back-out': (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  'elastic-out': (t) => (t === 0 || t === 1 ? t
    : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  'bounce-out': (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

export const EASE_NAMES = Object.keys(EASES);

// ---------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------

let idCounter = 1;
export function nextId(prefix = 'l') {
  return `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export function makeKey(t, over = {}) {
  return Object.assign({
    t,
    x: 0.5,
    y: 0.5,
    rot: 0,
    sx: 0.35,
    sy: 0.35,
    color: '#ff2020',
    color2: '#2040ff',
    alpha: 1,
    ease: 'linear',
    params: {},        // shape params being animated, by param key
  }, over);
}

/** Which lights a layer is allowed to affect. */
export function makeTarget(over = {}) {
  return Object.assign({
    mode: 'all',       // all | tags
    tags: [],
    match: 'any',      // any | all
    invert: false,
    exclude: [],       // lights carrying any of these tags are dropped
  }, over);
}

export function makeLayer(over = {}) {
  const shapeId = over.shapeId || 'bar';
  const layer = Object.assign({
    id: nextId(),
    name: 'Layer',
    enabled: true,
    kind: 'shape',     // shape | show | pattern
    blend: 'add',
    target: makeTarget(over.target),
    shapeId,
    shapeParams: shapeDefaults(shapeId),
    animParams: [],          // which shape params come from the keyframes
    image: 'white_line.png',
    colorMode: 'solid',      // solid | gradient | rainbow
    colorLerp: 'rgb',        // rgb | hsl
    rainbowSpread: 360,
    rainbowOffset: 0,
    startMs: 0,
    durationMs: 1000,
    repeat: 1,
    pingpong: false,
    holdBefore: false,
    holdAfter: false,
    keys: [],
  }, over);
  if (!layer.keys.length) {
    layer.keys = [
      makeKey(0, { x: 0.5, y: 0.85 }),
      makeKey(1, { x: 0.5, y: 0.15 }),
    ];
  }
  return layer;
}

export function makeProject(over = {}) {
  return Object.assign({
    version: PROJECT_VERSION,
    name: 'Untitled show',
    fps: 30,
    lightMap: 'monitor.yaml',
    tagFile: '',
    aspect: 0.5,             // playfield width / height
    durationMs: 0,           // 0 = derive from layers
    background: null,        // { name, opacity, visible }
    layers: [],
    export: {
      mpfTarget: '0.80',     // 0.80 = show_version 6 + duration steps; 0.50 = legacy
      blend: 'linear',       // linear | srgb - how overlapping layers add
      diffOnly: true,
      blackAsStop: true,
      trimStart: false,      // trimming the head shifts every cue earlier
      trimEnd: true,
      idleMode: 'collapse',  // collapse | hold | bare
      mode: 'colour',        // colour | bw | threshold
      threshold: 32,
      sampleRadius: 2,
      gamma: 1.0,
      minLevel: 0,
      fadeMs: 0,
      loop: false,
    },
  }, over);
}

export function starterProject() {
  const p = makeProject();
  p.layers.push(makeLayer({
    name: 'Sweep up',
    shapeId: 'bar',
    shapeParams: Object.assign(shapeDefaults('bar'), { len: 1.4, thick: 0.14, feather: 0.6 }),
    durationMs: 1000,
    keys: [
      makeKey(0, { x: 0.5, y: 0.95, sx: 0.9, sy: 0.9, color: '#00ff40', ease: 'sine-in-out' }),
      makeKey(1, { x: 0.5, y: 0.05, sx: 0.9, sy: 0.9, color: '#00ff40' }),
    ],
  }));
  return p;
}

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

export function layerEndMs(layer) {
  return layer.startMs + layer.durationMs * Math.max(1, layer.repeat || 1);
}

export function projectDuration(project) {
  if (project.durationMs > 0) return project.durationMs;
  let end = 0;
  for (const l of project.layers) end = Math.max(end, layerEndMs(l));
  return Math.max(end, 100);
}

export function frameCount(project) {
  const fps = project.fps || 30;
  return Math.max(1, Math.round((projectDuration(project) / 1000) * fps));
}

export function msPerFrame(project) {
  return 1000 / (project.fps || 30);
}

// ---------------------------------------------------------------------------
// interpolation
// ---------------------------------------------------------------------------

function sortedKeys(layer) {
  if (!layer._sorted || layer._sortedFor !== layer.keys) {
    layer._sorted = layer.keys.slice().sort((a, b) => a.t - b.t);
    layer._sortedFor = layer.keys;
  }
  return layer._sorted;
}

export function invalidateKeys(layer) {
  layer._sorted = null;
  layer._sortedFor = null;
}

function lerpColor(a, b, u, space) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  if (space === 'hsl') {
    const ha = rgbToHsl(ca.r, ca.g, ca.b);
    const hb = rgbToHsl(cb.r, cb.g, cb.b);
    let dh = hb.h - ha.h;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    const c = hslToRgb(ha.h + dh * u, ha.s + (hb.s - ha.s) * u, ha.l + (hb.l - ha.l) * u);
    return rgbToHex(c.r, c.g, c.b);
  }
  return rgbToHex(ca.r + (cb.r - ca.r) * u, ca.g + (cb.g - ca.g) * u, ca.b + (cb.b - ca.b) * u);
}

const NUMERIC = ['x', 'y', 'rot', 'sx', 'sy', 'alpha'];

/**
 * Shape parameters in force for a drawn state: the layer's own values, with
 * any animated ones replaced by the interpolated keyframe values.
 */
export function effectiveParams(layer, st) {
  const base = layer.shapeParams || {};
  if (!st || !st.params) return base;
  return Object.assign({}, base, st.params);
}

/** Pull an animated param off a keyframe, falling back to the layer value. */
function keyParam(layer, key, name) {
  if (key && key.params && key.params[name] != null) return key.params[name];
  const base = layer.shapeParams || {};
  return base[name] == null ? 0 : base[name];
}

/** Interpolated state at normalised position u (0..1) within the layer clip. */
export function stateAt(layer, u) {
  const keys = sortedKeys(layer);
  const anim = layer.animParams || [];

  // params are resolved the same way at every branch, so an animated shape
  // holds its first/last value outside the clip instead of snapping to the base
  const withParams = (state, key) => {
    if (!anim.length) return state;
    state.params = {};
    for (const name of anim) state.params[name] = keyParam(layer, key, name);
    return state;
  };

  if (!keys.length) return withParams(makeKey(0), null);
  if (keys.length === 1 || u <= keys[0].t) {
    return withParams(Object.assign({}, keys[0]), keys[0]);
  }
  const last = keys[keys.length - 1];
  if (u >= last.t) return withParams(Object.assign({}, last), last);

  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= u) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b.t - a.t;
  const raw = span <= 0 ? 0 : (u - a.t) / span;
  const ease = EASES[a.ease] || EASES.linear;
  const e = Math.max(0, Math.min(1, ease(Math.max(0, Math.min(1, raw)))));

  const out = Object.assign({}, a);
  for (const k of NUMERIC) out[k] = a[k] + (b[k] - a[k]) * e;
  out.color = lerpColor(a.color, b.color, e, layer.colorLerp);
  out.color2 = lerpColor(a.color2 || a.color, b.color2 || b.color, e, layer.colorLerp);
  out.t = u;
  if (anim.length) {
    out.params = {};
    for (const name of anim) {
      const av = keyParam(layer, a, name);
      const bv = keyParam(layer, b, name);
      out.params[name] = av + (bv - av) * e;
    }
  }
  return out;
}

/** Start animating a shape param: seed every keyframe with the current value. */
export function animateParam(layer, name) {
  layer.animParams = layer.animParams || [];
  if (layer.animParams.includes(name)) return;
  const base = (layer.shapeParams || {})[name];
  for (const k of layer.keys) {
    k.params = k.params || {};
    if (k.params[name] == null) k.params[name] = base;
  }
  layer.animParams.push(name);
}

/**
 * Give a shape parameter a start and an end value.
 *
 * Equal ends means it is not animated at all, so the layer keeps a single
 * value. Otherwise every keyframe gets its share, spread by keyframe TIME so
 * a 25-point path ramps smoothly rather than jumping at the last key.
 */
export function setParamRange(layer, name, from, to) {
  if (Math.abs(from - to) < 1e-9) {
    unanimateParam(layer, name);
    layer.shapeParams[name] = from;
    return;
  }
  animateParam(layer, name);
  spreadByTime(layer, (k, u) => { k.params[name] = from + (to - from) * u; });
}

/** The current start and end of a shape parameter. */
export function paramRange(layer, name) {
  const base = (layer.shapeParams || {})[name];
  if (!(layer.animParams || []).includes(name)) return { from: base, to: base };
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return { from: base, to: base };
  const first = keys[0].params || {};
  const last = keys[keys.length - 1].params || {};
  return {
    from: first[name] == null ? base : first[name],
    to: last[name] == null ? base : last[name],
  };
}

/**
 * Scale from one size to another across the clip.
 * `axis` is 'both', 'x' or 'y' - the two axes are independent, so a shape can
 * stretch sideways while keeping its height.
 */
export function setScaleRange(layer, from, to, axis = 'both') {
  spreadByTime(layer, (k, u) => {
    const v = Math.max(0.005, from + (to - from) * u);
    if (axis !== 'y') k.sx = v;
    if (axis !== 'x') k.sy = v;
  });
}

export function scaleRange(layer, axis = 'x') {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return { from: 0.5, to: 0.5 };
  const key = axis === 'y' ? 'sy' : 'sx';
  return { from: keys[0][key], to: keys[keys.length - 1][key] };
}

/** True when width and height match at both ends, so one control will do. */
export function scaleIsUniform(layer) {
  return layer.keys.every((k) => Math.abs(k.sx - k.sy) < 1e-6);
}

/** Whether the layer currently fades up at the start and/or down at the end. */
export function fadeState(layer) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return { in: false, out: false };
  return {
    in: keys[0].alpha === 0,
    out: keys[keys.length - 1].alpha === 0,
  };
}

/**
 * Turn the two fades on or off.
 *
 * These used to be one-way buttons that each zeroed an end keyframe, which had
 * two problems: nothing turned a fade back off, and asking for both on a layer
 * with only the two default keyframes set alpha to 0 at both ends with nothing
 * in between, so the whole layer interpolated to invisible. Wanting a fade in
 * and a fade out means wanting a bright middle, so if there is no interior
 * keyframe to be bright at, one is added.
 */
export function setFades(layer, fadeIn, fadeOut) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return;

  if (fadeIn && fadeOut && keys.length < 3) {
    const mid = makeKey(0.5, Object.assign({}, stateAt(layer, 0.5), { alpha: 1 }));
    layer.keys.push(mid);
    layer.keys.sort((a, b) => a.t - b.t);
    invalidateKeys(layer);
  }

  const sorted = layer.keys.slice().sort((a, b) => a.t - b.t);
  sorted[0].alpha = fadeIn ? 0 : 1;
  sorted[sorted.length - 1].alpha = fadeOut ? 0 : 1;

  // something between the ends has to reach full brightness, or a layer with
  // both fades on is dark from end to end
  const middle = sorted.slice(1, -1);
  if (middle.length && !middle.some((k) => k.alpha > 0)) {
    for (const k of middle) k.alpha = 1;
  }
  invalidateKeys(layer);
}

/** Turn from one angle to another across the clip. */
export function setRotationRange(layer, from, to) {
  spreadByTime(layer, (k, u) => { k.rot = Math.round((from + (to - from) * u) * 100) / 100; });
}

export function rotationRange(layer) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return { from: 0, to: 0 };
  return { from: keys[0].rot, to: keys[keys.length - 1].rot };
}

/** Fade from one colour to another across the clip. */
export function setColourRange(layer, from, to, space) {
  spreadByTime(layer, (k, u) => { k.color = lerpColor(from, to, u, space || layer.colorLerp); });
}

export function colourRange(layer) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return { from: '#ffffff', to: '#ffffff' };
  return { from: keys[0].color, to: keys[keys.length - 1].color };
}

/** Walk the keyframes in time order, handing each its 0..1 position. */
function spreadByTime(layer, fn) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return;
  const span = keys[keys.length - 1].t - keys[0].t;
  for (const k of keys) {
    k.params = k.params || {};
    fn(k, span > 0 ? (k.t - keys[0].t) / span : 0);
  }
  invalidateKeys(layer);
}

/** Stop animating a param, keeping the value from the first keyframe. */
export function unanimateParam(layer, name) {
  const i = (layer.animParams || []).indexOf(name);
  if (i < 0) return;
  const first = layer.keys.length ? layer.keys[0] : null;
  if (first && first.params && first.params[name] != null) {
    layer.shapeParams[name] = first.params[name];
  }
  layer.animParams.splice(i, 1);
  for (const k of layer.keys) if (k.params) delete k.params[name];
}

/**
 * Where is this layer at an absolute show time?
 * Returns null when the layer contributes nothing at that moment.
 */
export function layerStateAtTime(layer, timeMs) {
  if (!layer.enabled) return null;
  const dur = Math.max(1, layer.durationMs);
  const reps = Math.max(1, layer.repeat || 1);
  const local = timeMs - layer.startMs;

  if (local < 0) return layer.holdBefore ? stateAt(layer, 0) : null;
  if (local >= dur * reps) return layer.holdAfter ? stateAt(layer, 1) : null;

  const cycle = Math.floor(local / dur);
  let u = (local - cycle * dur) / dur;
  if (layer.pingpong && cycle % 2 === 1) u = 1 - u;
  return stateAt(layer, u);
}

// ---------------------------------------------------------------------------
// pattern layers
// ---------------------------------------------------------------------------

/**
 * Blink / chase settings. A pattern layer drives its lights directly at exact
 * colours instead of sampling pixels, which is what an on-off show needs: no
 * shape to position, and FF0000 really is FF0000.
 */
export function makePattern(over = {}) {
  return Object.assign({
    type: 'blink',        // blink | chase | sparkle | wavy | stack | marquee
                          // | fire | pinwheel | scanner | rain | plasma | solid
    // One cycle of the pattern spans the clip. Without it a pattern's own
    // timing is unrelated to the layer's length, so stretching a clip left the
    // pattern finishing early and sitting still for the rest.
    fit: true,
    color: '#ff2020',
    onMs: 500,
    offMs: 500,
    offMode: 'dark',      // dark | colour
    offColor: '#000000',
    // chase
    stepMs: 120,
    width: 1,
    tail: 0,
    order: 'name',        // name | x | y | angle
    reverse: false,
    // sparkle
    count: 4,
    colors: ['#ff2020', '#ffd400', '#40a0ff'],
    decay: 0.6,           // 0 = hard off at the end of its life, 1 = fades all through
    life: 1,              // how many steps a sparkle stays before being replaced
    seed: 1,
    // wavy
    axis: 'radial',       // radial | y | x - out from the centre reads best
    wavelength: 0.5,      // fraction of the group's extent per cycle
    periodMs: 1200,       // time for the wave to travel one wavelength
    floorLevel: 0.25,     // brightness in the trough, 0..1
    sharpness: 1,         // >1 tightens the crest
    waveColor2: '',       // trough colour; empty means dim the main colour
    // Snap the period so a whole number of cycles fits the clip. Without it the
    // wave is mid-stroke when the layer loops and the seam is visible as a jump.
    loop: true,
    // marquee
    every: 3,             // one light in every N is lit
    marqueeMs: 140,       // time before the lit set shifts along
    // fire
    fireMs: 90,           // how often the flicker is re-rolled
    fireHeat: 0.8,        // overall brightness before the flicker is added
    fireJitter: 0.45,     // how much the flicker moves it
    // pinwheel
    arms: 3,
    spinMs: 2000,
    armWidth: 0.35,       // fraction of the gap between arms that is lit
    // scanner
    sweepMs: 1400,
    bandWidth: 0.22,
    bounce: true,         // sweep back and forth rather than wrapping round
    // rain
    drops: 6,
    dropMs: 1400,
    tailLen: 0.25,
    // plasma
    plasmaScale: 2.2,
    plasmaMs: 3000,
    // stack
    cols: 4,
    rows: 6,
    fillMs: 1500,
    fillOrder: 'bottom-up',   // bottom-up | top-down | left-right | right-left
    fillMode: 'fill',         // fill (cells stay lit) | wipe (only the leading cell)
    color2: '#2060ff',
    // Tetris: show each cell travelling from the edge to its resting place
    // instead of appearing there. dropTrail dims the moving cell.
    drop: true,
    dropTrail: 0.55,
  }, over);
}

/**
 * Deterministic PRNG. Sparkle must pick the same lights every time the same
 * frame is rendered, or the preview would disagree with the export and two
 * exports of one show would differ.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Bounding box of the lights a layer targets, so effects fill the group. */
export function targetBounds(layer, lights, mask) {
  if (layer._boundsFor === lights && layer._boundsMask === mask) return layer._bounds;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let n = 0;
  for (let i = 0; i < lights.length; i++) {
    if (mask && !mask[i]) continue;
    const l = lights[i];
    if (l.x < minX) minX = l.x;
    if (l.x > maxX) maxX = l.x;
    if (l.y < minY) minY = l.y;
    if (l.y > maxY) maxY = l.y;
    n++;
  }
  const b = n ? { minX, maxX, minY, maxY, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY), n }
              : { minX: 0, maxX: 1, minY: 0, maxY: 1, w: 1, h: 1, n: 0 };
  layer._bounds = b;
  layer._boundsFor = lights;
  layer._boundsMask = mask;
  return b;
}

export function makePatternLayer(over = {}) {
  const layer = makeLayer(Object.assign({
    kind: 'pattern',
    name: 'Blink',
    blend: 'add',
    durationMs: 2000,
    keys: [makeKey(0, { alpha: 1 }), makeKey(1, { alpha: 1 })],
  }, over));
  // fill the pattern in after the merge: a partial `over.pattern` would
  // otherwise replace the defaults wholesale and leave fields undefined
  layer.kind = 'pattern';
  layer.pattern = makePattern(over.pattern);
  return layer;
}

/** Natural sort so l_rocket_2 comes before l_rocket_10. */
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = String(a).toLowerCase().match(re) || [];
  const bx = String(b).toLowerCase().match(re) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = parseInt(ax[i], 10);
    const bn = parseInt(bx[i], 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/**
 * Indices of the lights a pattern layer drives, in chase order.
 * Cached against the light list, the mask and the ordering rule.
 */
export function orderedTargets(layer, lights, mask) {
  const p = layer.pattern || {};
  const key = `${p.order}|${p.reverse ? 1 : 0}`;
  if (layer._orderFor === lights && layer._orderMask === mask && layer._orderKey === key) {
    return layer._order;
  }
  const idx = [];
  for (let i = 0; i < lights.length; i++) if (!mask || mask[i]) idx.push(i);

  if (p.order === 'x') {
    idx.sort((a, b) => lights[a].x - lights[b].x);
  } else if (p.order === 'y') {
    idx.sort((a, b) => lights[a].y - lights[b].y);
  } else if (p.order === 'angle') {
    let cx = 0, cy = 0;
    for (const i of idx) { cx += lights[i].x; cy += lights[i].y; }
    cx /= Math.max(1, idx.length); cy /= Math.max(1, idx.length);
    idx.sort((a, a2) => Math.atan2(lights[a].y - cy, lights[a].x - cx)
                      - Math.atan2(lights[a2].y - cy, lights[a2].x - cx));
  } else {
    idx.sort((a, b) => naturalCompare(lights[a].name, lights[b].name));
  }
  if (p.reverse) idx.reverse();

  layer._order = idx;
  layer._orderFor = lights;
  layer._orderMask = mask;
  layer._orderKey = key;
  return idx;
}

/**
 * Where a pattern layer is in its own cycle at an absolute show time.
 * Returns null when the layer is not showing.
 */
export function patternTimeAt(layer, timeMs) {
  const dur = Math.max(1, layer.durationMs);
  const reps = Math.max(1, layer.repeat || 1);
  const local = timeMs - layer.startMs;
  if (local < 0) return layer.holdBefore ? 0 : null;
  if (local >= dur * reps) return layer.holdAfter ? dur * reps : null;
  return local;
}

// ---------------------------------------------------------------------------
// imported MPF shows
// ---------------------------------------------------------------------------

/**
 * Build a layer that replays an imported MPF show.
 * `data` is what /api/showfile returns: absolute-indexed steps.
 */
export function makeShowLayer(data, fps, lights, lightMapName) {
  const frames = Math.max(1, data.frames || 0);
  const durationMs = Math.round((frames / (fps || 30)) * 1000);
  const names = data.lightNames || [];

  // Where the show's lights physically sit. An MPF show yaml has no positions,
  // so the server supplies them from whichever light map names the most of
  // them; failing that, fall back to the map loaded right now. This snapshot is
  // what lets the show be remapped when names later change.
  let pos = data.positions || null;
  if (!pos || !Object.keys(pos).length) {
    pos = {};
    if (lights && lights.length) {
      const byName = new Map(lights.map((l) => [l.name, l]));
      for (const n of names) {
        const l = byName.get(n);
        if (l) pos[n] = [Math.round(l.x * 1e4) / 1e4, Math.round(l.y * 1e4) / 1e4];
      }
    }
  }

  return makeLayer({
    kind: 'show',
    name: data.name ? data.name.replace(/\.(yaml|yml)$/i, '') : 'Imported show',
    blend: 'add',
    durationMs,
    remap: 'name',          // name | nearest
    show: {
      name: data.name || '',
      source: data.source || 'imports',
      sourceMap: data.positionMap || lightMapName || '',
      frames,
      lightNames: names,
      positions: pos,
      steps: data.steps || [],
    },
    keys: [makeKey(0, { alpha: 1 }), makeKey(1, { alpha: 1 })],
  });
}

/**
 * Work out which light in the CURRENT map each of a show's lights drives.
 * Names are the source of truth, so a light that merely moved keeps working.
 * With remap 'nearest', a name that has disappeared falls back to the closest
 * light to where it used to be.
 *
 * Returns { index: Int32Array, byName, byPosition, unmatched, missing[] }.
 */
export function mapShowToLights(layer, lights, maxDist = 0.08) {
  const show = layer.show;
  if (!show) return null;
  const names = show.lightNames || [];
  const byNameMap = new Map(lights.map((l, i) => [l.name, i]));
  const index = new Int32Array(names.length).fill(-1);
  const positions = show.positions || {};
  const missing = [];
  let byName = 0;
  let byPosition = 0;

  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (byNameMap.has(n)) {
      index[i] = byNameMap.get(n);
      byName++;
      continue;
    }
    if (layer.remap === 'nearest' && positions[n]) {
      const [sx, sy] = positions[n];
      let best = -1;
      let bestD = maxDist * maxDist;
      for (let j = 0; j < lights.length; j++) {
        const dx = lights[j].x - sx;
        const dy = lights[j].y - sy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) { index[i] = best; byPosition++; continue; }
    }
    missing.push(n);
  }

  return { index, byName, byPosition, unmatched: missing.length, missing, total: names.length };
}

/**
 * Expand the sparse step list into one absolute colour per light per frame.
 * Cached on the layer; MPF steps are diffs, so values carry forward.
 */
export function resolveShow(layer) {
  const show = layer.show;
  if (!show) return null;
  if (layer._resolved && layer._resolvedFor === show.steps) return layer._resolved;

  const names = show.lightNames.slice();
  const index = new Map(names.map((n, i) => [n, i]));
  const frames = Math.max(1, show.frames);
  const data = new Uint8Array(frames * names.length * 3);

  const cur = new Uint8Array(names.length * 3);
  let step = 0;
  const steps = show.steps.slice().sort((a, b) => a.index - b.index);

  for (let f = 0; f < frames; f++) {
    while (step < steps.length && steps[step].index === f) {
      for (const [name, value] of Object.entries(steps[step].lights)) {
        const i = index.get(name);
        if (i == null) continue;
        if (value == null) {
          cur[i * 3] = 0; cur[i * 3 + 1] = 0; cur[i * 3 + 2] = 0;
        } else {
          cur[i * 3] = parseInt(value.slice(0, 2), 16) || 0;
          cur[i * 3 + 1] = parseInt(value.slice(2, 4), 16) || 0;
          cur[i * 3 + 2] = parseInt(value.slice(4, 6), 16) || 0;
        }
      }
      step++;
    }
    data.set(cur, f * names.length * 3);
  }

  layer._resolved = { names, frames, data, stride: names.length * 3 };
  layer._resolvedFor = show.steps;
  return layer._resolved;
}

/** Which source frame of an imported show is showing at an absolute time. */
export function showFrameAt(layer, timeMs) {
  const dur = Math.max(1, layer.durationMs);
  const reps = Math.max(1, layer.repeat || 1);
  const local = timeMs - layer.startMs;
  const resolved = resolveShow(layer);
  if (!resolved) return -1;

  if (local < 0) return layer.holdBefore ? 0 : -1;
  if (local >= dur * reps) return layer.holdAfter ? resolved.frames - 1 : -1;

  const cycle = Math.floor(local / dur);
  let u = (local - cycle * dur) / dur;
  if (layer.pingpong && cycle % 2 === 1) u = 1 - u;
  return Math.max(0, Math.min(resolved.frames - 1, Math.floor(u * resolved.frames)));
}

// ---------------------------------------------------------------------------
// migration / validation of loaded files
// ---------------------------------------------------------------------------

export function normaliseProject(raw) {
  const p = makeProject(raw || {});
  p.layers = (raw && raw.layers ? raw.layers : []).map((l) => {
    const layer = makeLayer(Object.assign({}, l, { keys: (l.keys || []).slice() }));
    layer.target = makeTarget(l.target || {});
    layer.kind = ['show', 'pattern'].includes(l.kind) ? l.kind : 'shape';
    if (layer.kind === 'pattern') layer.pattern = makePattern(l.pattern || {});
    layer.shapeParams = Object.assign(shapeDefaults(layer.shapeId), l.shapeParams || {});
    layer.animParams = Array.isArray(l.animParams) ? l.animParams.slice() : [];
    if (l.seedKey) layer.seedKey = l.seedKey;
    layer.keys = layer.keys.map((k) => makeKey(k.t, Object.assign({}, k,
      { params: Object.assign({}, k.params || {}) }))).sort((a, b) => a.t - b.t);
    if (layer.keys.length === 0) layer.keys = [makeKey(0), makeKey(1)];
    invalidateKeys(layer);
    return layer;
  });
  p.export = Object.assign(makeProject().export, raw && raw.export ? raw.export : {});
  // migrate the old single trimIdle flag
  if (raw && raw.export && 'trimIdle' in raw.export) {
    const legacy = raw.export.trimIdle !== false;
    if (!('trimStart' in raw.export)) p.export.trimStart = legacy;
    if (!('trimEnd' in raw.export)) p.export.trimEnd = legacy;
    delete p.export.trimIdle;
  }
  return p;
}

/** Strip cached fields so saved files stay clean. */
export function serialiseProject(project) {
  return JSON.parse(JSON.stringify(project, (key, value) => (key.startsWith('_') ? undefined : value)));
}
