// Motion paths and keyframe transforms.
//
// A path rewrites only the x/y of a layer's keyframes. Colour, scale, rotation,
// brightness and any animated shape params are resampled from the layer as it
// was, so putting a sweep onto a circle keeps everything else you had set up.
//
// Positions are normalised 0..1 on both axes, but the playfield is roughly 1:2,
// so a shape that should look round needs its y radius scaled by the aspect.

import { makeKey, stateAt, invalidateKeys } from './project.js';

const TAU = Math.PI * 2;

/** Each path returns n points in normalised space. */
export const PATHS = [
  {
    id: 'none',
    label: 'None',
    // handled directly in applyPath; it collapses rather than plots a route
    points() { return []; },
  },
  {
    id: 'circle',
    label: 'Circle',
    points(n, o) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + o.rotate;
        out.push({ x: o.cx + Math.cos(a) * o.r,
                   y: o.cy + Math.sin(a) * o.r * o.aspect * o.stretch });
      }
      out.push({ x: out[0].x, y: out[0].y });   // close the loop
      return out;
    },
  },
  {
    id: 'infinity',
    label: 'Infinity',
    points(n, o) {
      const out = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * TAU + o.rotate;
        const d = 1 + Math.sin(t) * Math.sin(t);
        out.push({
          x: o.cx + (Math.cos(t) / d) * o.r,
          y: o.cy + ((Math.sin(t) * Math.cos(t)) / d) * o.r * o.aspect * 2 * o.stretch,
        });
      }
      return out;
    },
  },
  {
    id: 'spiral',
    label: 'Spiral',
    points(n, o) {
      const out = [];
      const turns = Math.max(0.25, o.turns);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const a = u * TAU * turns + o.rotate;
        const r = o.r * (o.inward ? 1 - u : u);
        out.push({ x: o.cx + Math.cos(a) * r,
                   y: o.cy + Math.sin(a) * r * o.aspect * o.stretch });
      }
      return out;
    },
  },
  {
    id: 'zigzag',
    label: 'Zig-zag',
    points(n, o) {
      const out = [];
      const legs = Math.max(2, Math.round(o.turns * 2));
      for (let i = 0; i <= legs; i++) {
        const u = i / legs;
        out.push({
          x: o.cx + (i % 2 === 0 ? -o.r : o.r),
          y: (o.down ? u : 1 - u) * (1 + o.overshoot * 2) - o.overshoot,
        });
      }
      return out;
    },
  },
  {
    id: 'diagonal',
    label: 'Diagonal',
    points(n, o) {
      const a = o.reverse ? { x: 1 + o.overshoot, y: -o.overshoot }
                          : { x: -o.overshoot, y: -o.overshoot };
      const b = o.reverse ? { x: -o.overshoot, y: 1 + o.overshoot }
                          : { x: 1 + o.overshoot, y: 1 + o.overshoot };
      return [a, b];
    },
  },
  {
    id: 'sides',
    label: 'Down and round',
    points(n, o) {
      // down one edge, across the bottom, back up the other
      const L = o.cx - o.r, R = o.cx + o.r;
      return [
        { x: L, y: -o.overshoot }, { x: L, y: 0.9 },
        { x: R, y: 0.9 }, { x: R, y: -o.overshoot },
      ];
    },
  },
  {
    id: 'bounce',
    label: 'Bounce across',
    points(n, o) {
      const out = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        out.push({
          x: -o.overshoot + u * (1 + o.overshoot * 2),
          y: o.cy + Math.abs(Math.sin(u * Math.PI * Math.max(1, o.turns)))
                    * -o.r * o.aspect * 2 * o.stretch,
        });
      }
      return out;
    },
  },
  {
    id: 'sweep-up',
    label: 'Straight up',
    points(n, o) {
      return [{ x: o.cx, y: 1 + o.overshoot }, { x: o.cx, y: -o.overshoot }];
    },
  },
];

export const PATH_BY_ID = new Map(PATHS.map((p) => [p.id, p]));

export function pathOptions(over = {}) {
  return Object.assign({
    cx: 0.5, cy: 0.5, r: 0.35, rotate: 0, turns: 3,
    // stretch scales the vertical extent only. The playfield is about 1:2, so
    // a round-looking circle is much shorter than it is wide; stretch is how a
    // spiral or figure-8 gets to fill the tall space instead of a flat band.
    stretch: 1,
    aspect: 0.5, overshoot: 0.1, inward: false, reverse: false, down: true,
    points: 24,
  }, over);
}

/**
 * Replace a layer's keyframe positions with a path, resampling everything
 * else from the layer's existing animation so nothing else is lost.
 */
export function applyPath(layer, pathId, over = {}) {
  const def = PATH_BY_ID.get(pathId);
  if (!def) return;

  // "None" means no travel: collapse to a stationary pair where it already is,
  // keeping colour, size, rotation and any animated shape params at each end.
  if (pathId === 'none') {
    const sorted = layer.keys.slice().sort((a, b) => a.t - b.t);
    const here = sorted.length ? { x: sorted[0].x, y: sorted[0].y } : { x: 0.5, y: 0.5 };
    const a0 = stateAt(layer, 0);
    const a1 = stateAt(layer, 1);
    layer.keys = [
      makeKey(0, Object.assign({}, a0, { t: 0, x: here.x, y: here.y,
        params: Object.assign({}, a0.params || {}) })),
      makeKey(1, Object.assign({}, a1, { t: 1, x: here.x, y: here.y,
        params: Object.assign({}, a1.params || {}) })),
    ];
    invalidateKeys(layer);
    return;
  }
  const o = pathOptions(over);
  const pts = def.points(Math.max(2, Math.round(o.points)), o);
  const n = pts.length;

  // sample the old animation first, since we are about to replace the keys
  const sampled = pts.map((_, i) => stateAt(layer, n === 1 ? 0 : i / (n - 1)));

  layer.keys = pts.map((p, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    const st = sampled[i];
    return makeKey(t, Object.assign({}, st, {
      t,
      x: Math.round(p.x * 1e4) / 1e4,
      y: Math.round(p.y * 1e4) / 1e4,
      params: Object.assign({}, st.params || {}),
    }));
  });
  invalidateKeys(layer);
}

/** Width and height a path will span, as fractions of the playfield. */
export function pathExtent(pathId, over = {}) {
  const def = PATH_BY_ID.get(pathId);
  if (!def || pathId === 'none') return { w: 0, h: 0 };
  const o = pathOptions(over);
  const pts = def.points(Math.max(2, Math.round(o.points)), o);
  if (!pts.length) return { w: 0, h: 0 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// ---------------------------------------------------------------------------
// keyframe transforms
// ---------------------------------------------------------------------------

export const TRANSFORMS = [
  {
    id: 'mirror-x',
    label: 'Mirror left/right',
    apply(layer) { for (const k of layer.keys) k.x = 1 - k.x; },
  },
  {
    id: 'mirror-y',
    label: 'Mirror up/down',
    apply(layer) { for (const k of layer.keys) k.y = 1 - k.y; },
  },
  {
    id: 'rotate-grow',
    label: 'Rotate and grow',
    apply(layer) {
      const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
      if (keys.length < 2) return;
      const first = keys[0];
      keys.forEach((k, i) => {
        const u = i / (keys.length - 1);
        k.rot = first.rot + 360 * u;
        k.sx = first.sx * (1 + u * 2);
        k.sy = first.sy * (1 + u * 2);
      });
    },
  },
  {
    id: 'rotate-shrink',
    label: 'Rotate and shrink',
    apply(layer) {
      const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
      if (keys.length < 2) return;
      const first = keys[0];
      keys.forEach((k, i) => {
        const u = i / (keys.length - 1);
        k.rot = first.rot - 360 * u;
        k.sx = Math.max(0.01, first.sx * (1 - u * 0.9));
        k.sy = Math.max(0.01, first.sy * (1 - u * 0.9));
      });
    },
  },
  {
    id: 'reverse-path',
    label: 'Reverse direction',
    apply(layer) {
      const pos = layer.keys.slice().sort((a, b) => a.t - b.t).map((k) => ({ x: k.x, y: k.y }));
      pos.reverse();
      layer.keys.slice().sort((a, b) => a.t - b.t).forEach((k, i) => {
        k.x = pos[i].x; k.y = pos[i].y;
      });
    },
  },
];

// ---------------------------------------------------------------------------
// whole turns
// ---------------------------------------------------------------------------

/** How many full turns the layer currently makes across its clip. */
export function turnsOf(layer) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (keys.length < 2) return 0;
  return (keys[keys.length - 1].rot - keys[0].rot) / 360;
}

/**
 * Spin the layer a given number of turns over its clip.
 *
 * Spread by keyframe TIME rather than index, so unevenly spaced keyframes still
 * rotate at a constant rate instead of lurching between them. Negative turns
 * go the other way; fractions are allowed but whole numbers are the easy case.
 */
export function setTurns(layer, turns) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (keys.length < 2) return;
  const start = keys[0].rot;
  const span = keys[keys.length - 1].t - keys[0].t;
  const total = turns * 360;
  for (const k of keys) {
    const u = span > 0 ? (k.t - keys[0].t) / span : 0;
    k.rot = Math.round((start + total * u) * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// randomisers
// ---------------------------------------------------------------------------

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/** Somewhere in the middle half of the playfield, so it starts on-screen. */
export function randomStart(layer) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return;
  keys[0].x = Math.round(rand(0.25, 0.75) * 1e3) / 1e3;
  keys[0].y = Math.round(rand(0.25, 0.75) * 1e3) / 1e3;
}

/** Just off one of the four edges, so it exits cleanly. */
export function randomEnd(layer, margin = 0.15) {
  const keys = layer.keys.slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return;
  const k = keys[keys.length - 1];
  const edge = Math.floor(Math.random() * 4);
  if (edge === 0) { k.x = rand(0, 1); k.y = -margin; }
  else if (edge === 1) { k.x = rand(0, 1); k.y = 1 + margin; }
  else if (edge === 2) { k.x = -margin; k.y = rand(0, 1); }
  else { k.x = 1 + margin; k.y = rand(0, 1); }
  k.x = Math.round(k.x * 1e3) / 1e3;
  k.y = Math.round(k.y * 1e3) / 1e3;
}

// ---------------------------------------------------------------------------
// size presets
// ---------------------------------------------------------------------------

export const SIZE_PRESETS = [
  { id: 'xs', label: 'XS', scale: 0.12 },
  { id: 's', label: 'S', scale: 0.3 },
  { id: 'm', label: 'M', scale: 0.6 },
  { id: 'l', label: 'L', scale: 1.1 },
  { id: 'xl', label: 'XL', scale: 2.0 },
];

/** Set one keyframe, or every keyframe, to a preset size. */
export function applySize(layer, scale, allKeys, key) {
  const targets = allKeys ? layer.keys : (key ? [key] : layer.keys.slice(0, 1));
  for (const k of targets) { k.sx = scale; k.sy = scale; }
}
