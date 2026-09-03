// Ready-made layers. Each one is a complete, playable effect that you can drop
// in and then tweak, rather than starting from a bare shape every time.

import { makeLayer, makeKey, makePatternLayer } from './project.js';
import { shapeDefaults } from './shapes.js';

const S = (id, over) => Object.assign(shapeDefaults(id), over || {});

export const PRESETS = [
  {
    id: 'sweep-up',
    name: 'Sweep up',
    group: 'Wipes',
    build: (c) => makeLayer({
      name: 'Sweep up', shapeId: 'bar', durationMs: 900,
      shapeParams: S('bar', { len: 1.6, thick: 0.16, feather: 0.7 }),
      keys: [
        makeKey(0, { x: 0.5, y: 1.08, sx: 0.9, sy: 0.9, color: c, ease: 'sine-in-out' }),
        makeKey(1, { x: 0.5, y: -0.08, sx: 0.9, sy: 0.9, color: c }),
      ],
    }),
  },
  {
    id: 'sweep-down',
    name: 'Sweep down',
    group: 'Wipes',
    build: (c) => makeLayer({
      name: 'Sweep down', shapeId: 'bar', durationMs: 900,
      shapeParams: S('bar', { len: 1.6, thick: 0.16, feather: 0.7 }),
      keys: [
        makeKey(0, { x: 0.5, y: -0.08, sx: 0.9, sy: 0.9, color: c, ease: 'sine-in-out' }),
        makeKey(1, { x: 0.5, y: 1.08, sx: 0.9, sy: 0.9, color: c }),
      ],
    }),
  },
  {
    id: 'wipe-right',
    name: 'Wipe right',
    group: 'Wipes',
    build: (c) => makeLayer({
      name: 'Wipe right', shapeId: 'bar', durationMs: 700,
      shapeParams: S('bar', { len: 2.4, thick: 0.14, feather: 0.6 }),
      keys: [
        makeKey(0, { x: -0.1, y: 0.5, rot: 90, sx: 0.8, sy: 0.8, color: c }),
        makeKey(1, { x: 1.1, y: 0.5, rot: 90, sx: 0.8, sy: 0.8, color: c }),
      ],
    }),
  },
  {
    id: 'diag-wipe',
    name: 'Diagonal wipe',
    group: 'Wipes',
    build: (c) => makeLayer({
      name: 'Diagonal wipe', shapeId: 'bar', durationMs: 900,
      shapeParams: S('bar', { len: 2.6, thick: 0.18, feather: 0.8 }),
      keys: [
        makeKey(0, { x: -0.1, y: 1.1, rot: 45, sx: 0.9, sy: 0.9, color: c, ease: 'sine-in-out' }),
        makeKey(1, { x: 1.1, y: -0.1, rot: 45, sx: 0.9, sy: 0.9, color: c }),
      ],
    }),
  },

  {
    id: 'ring-out',
    name: 'Expanding ring',
    group: 'Radial',
    build: (c) => makeLayer({
      name: 'Expanding ring', shapeId: 'ring', durationMs: 800,
      shapeParams: S('ring', { thick: 0.16, feather: 0.7 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, sx: 0.03, sy: 0.03, color: c, alpha: 1, ease: 'expo-out' }),
        makeKey(1, { x: 0.5, y: 0.5, sx: 2.2, sy: 2.2, color: c, alpha: 0 }),
      ],
    }),
  },
  {
    id: 'ring-in',
    name: 'Collapsing ring',
    group: 'Radial',
    build: (c) => makeLayer({
      name: 'Collapsing ring', shapeId: 'ring', durationMs: 800,
      shapeParams: S('ring', { thick: 0.16, feather: 0.7 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, sx: 2.2, sy: 2.2, color: c, alpha: 0, ease: 'expo-in' }),
        makeKey(1, { x: 0.5, y: 0.5, sx: 0.03, sy: 0.03, color: c, alpha: 1 }),
      ],
    }),
  },
  {
    id: 'radar',
    name: 'Radar sweep',
    group: 'Radial',
    build: (c) => makeLayer({
      name: 'Radar sweep', shapeId: 'sweep', durationMs: 1200,
      shapeParams: S('sweep', { span: 110, thick: 0.5, feather: 0.25 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, rot: 0, sx: 1.6, sy: 1.6, color: c, ease: 'linear' }),
        makeKey(1, { x: 0.5, y: 0.5, rot: 360, sx: 1.6, sy: 1.6, color: c }),
      ],
    }),
  },
  {
    id: 'spinner',
    name: 'Spinning bar',
    group: 'Radial',
    build: (c) => makeLayer({
      name: 'Spinning bar', shapeId: 'bar', durationMs: 1000,
      shapeParams: S('bar', { len: 1.0, thick: 0.1, feather: 0.4, taper: 0.4 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, rot: 0, sx: 1.2, sy: 1.2, color: c }),
        makeKey(1, { x: 0.5, y: 0.5, rot: 360, sx: 1.2, sy: 1.2, color: c }),
      ],
    }),
  },
  {
    id: 'rainbow-spin',
    name: 'Rainbow spin',
    group: 'Radial',
    build: () => makeLayer({
      name: 'Rainbow spin', shapeId: 'circle', durationMs: 1500,
      colorMode: 'rainbow', rainbowSpread: 360,
      shapeParams: S('circle', { feather: 0.15 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, rot: 0, sx: 1.5, sy: 1.5 }),
        makeKey(1, { x: 0.5, y: 0.5, rot: 360, sx: 1.5, sy: 1.5 }),
      ],
    }),
  },
  {
    id: 'starburst',
    name: 'Starburst',
    group: 'Radial',
    build: (c) => makeLayer({
      name: 'Starburst', shapeId: 'cross', durationMs: 650,
      shapeParams: S('cross', { arms: 8, thick: 0.1, taper: 0.85 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, rot: 0, sx: 0.05, sy: 0.05, color: c, alpha: 1, ease: 'expo-out' }),
        makeKey(1, { x: 0.5, y: 0.5, rot: 45, sx: 1.9, sy: 1.9, color: c, alpha: 0 }),
      ],
    }),
  },
  {
    id: 'spiral',
    name: 'Spiral spin',
    group: 'Radial',
    build: (c) => makeLayer({
      name: 'Spiral', shapeId: 'spiral', durationMs: 1600,
      shapeParams: S('spiral', { turns: 3, thick: 0.07, taper: 0.7 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, rot: 0, sx: 1.6, sy: 1.6, color: c }),
        makeKey(1, { x: 0.5, y: 0.5, rot: 720, sx: 1.6, sy: 1.6, color: c }),
      ],
    }),
  },

  {
    id: 'chase',
    name: 'Dot chase',
    group: 'Motion',
    build: (c) => makeLayer({
      name: 'Dot chase', shapeId: 'dots', durationMs: 1000,
      shapeParams: S('dots', { count: 10, radius: 0.45, size: 0.09, arc: 120, fade: 0.85, feather: 0.5 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, rot: 0, sx: 1.4, sy: 1.4, color: c }),
        makeKey(1, { x: 0.5, y: 0.5, rot: 360, sx: 1.4, sy: 1.4, color: c }),
      ],
    }),
  },
  {
    id: 'comet',
    name: 'Comet',
    group: 'Motion',
    build: (c) => makeLayer({
      name: 'Comet', shapeId: 'beam', durationMs: 850,
      shapeParams: S('beam', { len: 0.7, near: 0.02, far: 0.22, fade: 0.9, feather: 0.7 }),
      keys: [
        makeKey(0, { x: 0.15, y: 1.05, rot: -60, sx: 0.7, sy: 0.7, color: c, ease: 'sine-out' }),
        makeKey(0.5, { x: 0.5, y: 0.45, rot: -90, sx: 0.8, sy: 0.8, color: c, ease: 'sine-in' }),
        makeKey(1, { x: 0.85, y: -0.05, rot: -120, sx: 0.7, sy: 0.7, color: c, alpha: 0.2 }),
      ],
    }),
  },
  {
    id: 'zigzag',
    name: 'Zig-zag drop',
    group: 'Motion',
    build: (c) => makeLayer({
      name: 'Zig-zag drop', shapeId: 'halo', durationMs: 1200,
      shapeParams: S('halo', { falloff: 2.4, core: 0.06 }),
      keys: [
        makeKey(0, { x: 0.2, y: -0.05, sx: 0.35, sy: 0.35, color: c }),
        makeKey(0.25, { x: 0.75, y: 0.25, sx: 0.35, sy: 0.35, color: c }),
        makeKey(0.5, { x: 0.25, y: 0.5, sx: 0.35, sy: 0.35, color: c }),
        makeKey(0.75, { x: 0.8, y: 0.75, sx: 0.35, sy: 0.35, color: c }),
        makeKey(1, { x: 0.3, y: 1.05, sx: 0.35, sy: 0.35, color: c }),
      ],
    }),
  },
  {
    id: 'chevrons',
    name: 'Chevron march',
    group: 'Motion',
    build: (c) => makeLayer({
      name: 'Chevron march', shapeId: 'chevron', durationMs: 900,
      shapeParams: S('chevron', { count: 4, thick: 0.09, spread: 0.26, angle: 70, fade: 0.6 }),
      keys: [
        makeKey(0, { x: 0.5, y: 1.15, rot: -90, sx: 1.0, sy: 1.0, color: c }),
        makeKey(1, { x: 0.5, y: -0.15, rot: -90, sx: 1.0, sy: 1.0, color: c }),
      ],
    }),
  },

  {
    id: 'pulse',
    name: 'Pulse (whole field)',
    group: 'Flashes',
    build: (c) => makeLayer({
      name: 'Pulse', shapeId: 'halo', durationMs: 500, repeat: 2,
      shapeParams: S('halo', { falloff: 1.4, core: 0.35 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, sx: 2.4, sy: 2.4, color: c, alpha: 0, ease: 'sine-out' }),
        makeKey(0.35, { x: 0.5, y: 0.5, sx: 2.4, sy: 2.4, color: c, alpha: 1, ease: 'sine-in' }),
        makeKey(1, { x: 0.5, y: 0.5, sx: 2.4, sy: 2.4, color: c, alpha: 0 }),
      ],
    }),
  },
  {
    id: 'strobe',
    name: 'Strobe',
    group: 'Flashes',
    build: (c) => makeLayer({
      name: 'Strobe', shapeId: 'bar', durationMs: 200, repeat: 5,
      shapeParams: S('bar', { len: 3, thick: 3 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, sx: 1.2, sy: 2.4, color: c, alpha: 1, ease: 'hold' }),
        makeKey(0.35, { x: 0.5, y: 0.5, sx: 1.2, sy: 2.4, color: c, alpha: 0, ease: 'hold' }),
        makeKey(1, { x: 0.5, y: 0.5, sx: 1.2, sy: 2.4, color: c, alpha: 0 }),
      ],
    }),
  },
  {
    id: 'colour-fade',
    name: 'Colour fade (whole field)',
    group: 'Flashes',
    build: (c) => makeLayer({
      name: 'Colour fade', shapeId: 'bar', durationMs: 1500, colorLerp: 'hsl',
      shapeParams: S('bar', { len: 3, thick: 3 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, sx: 1.2, sy: 2.4, color: c }),
        makeKey(0.5, { x: 0.5, y: 0.5, sx: 1.2, sy: 2.4, color: rotateHue(c, 120) }),
        makeKey(1, { x: 0.5, y: 0.5, sx: 1.2, sy: 2.4, color: rotateHue(c, 240) }),
      ],
    }),
  },
  {
    id: 'blink-slow',
    name: 'Blink 0.5s',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Blink', durationMs: 3000,
      pattern: { type: 'blink', color: c, onMs: 500, offMs: 500 },
    }),
  },
  {
    id: 'blink-fast',
    name: 'Blink fast',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Fast blink', durationMs: 2000,
      pattern: { type: 'blink', color: c, onMs: 120, offMs: 120 },
    }),
  },
  {
    id: 'flash-once',
    name: 'Flash once',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Flash', durationMs: 250,
      pattern: { type: 'blink', color: c, onMs: 150, offMs: 100 },
    }),
  },
  {
    id: 'chase-names',
    name: 'Chase',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Chase', durationMs: 3000,
      pattern: { type: 'chase', color: c, stepMs: 120, width: 1, tail: 2, order: 'name' },
    }),
  },
  {
    id: 'chase-updown',
    name: 'Chase up',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Chase up', durationMs: 3000,
      pattern: { type: 'chase', color: c, stepMs: 100, width: 2, tail: 3,
                 order: 'y', reverse: true },
    }),
  },
  {
    id: 'sparkle',
    name: 'Sparkle',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Sparkle', durationMs: 4000,
      pattern: { type: 'sparkle', color: c, count: 4, stepMs: 120, life: 3, decay: 0.9,
                 colors: [c, '#ffffff', '#ffd400'] },
    }),
  },
  {
    id: 'wavy',
    name: 'Wave',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Wave', durationMs: 4000,
      pattern: { type: 'wavy', color: c, axis: 'y', wavelength: 0.5,
                 periodMs: 1200, floorLevel: 0, sharpness: 2 },
    }),
  },
  {
    id: 'stack',
    name: 'Stack up',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Stack', durationMs: 2000,
      pattern: { type: 'stack', color: c, color2: '#ffffff', cols: 4, rows: 6,
                 fillMs: 2000, fillOrder: 'bottom-up', fillMode: 'fill' },
    }),
  },
  {
    id: 'solid-on',
    name: 'Solid on',
    group: 'Tagged patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Solid', durationMs: 1000,
      pattern: { type: 'solid', color: c },
    }),
  },
  {
    id: 'blank',
    name: 'Blank layer',
    group: 'Basic',
    build: (c) => makeLayer({
      name: 'Layer', shapeId: 'circle', durationMs: 1000,
      shapeParams: S('circle', { feather: 0.4 }),
      keys: [
        makeKey(0, { x: 0.5, y: 0.8, sx: 0.3, sy: 0.3, color: c }),
        makeKey(1, { x: 0.5, y: 0.2, sx: 0.3, sy: 0.3, color: c }),
      ],
    }),
  },
];

function rotateHue(hex, deg) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  hue = (hue + deg) % 360;
  const c2 = (1 - Math.abs(2 * l - 1)) * s;
  const x = c2 * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c2 / 2;
  let rr = 0, gg = 0, bb = 0;
  if (hue < 60) [rr, gg, bb] = [c2, x, 0];
  else if (hue < 120) [rr, gg, bb] = [x, c2, 0];
  else if (hue < 180) [rr, gg, bb] = [0, c2, x];
  else if (hue < 240) [rr, gg, bb] = [0, x, c2];
  else if (hue < 300) [rr, gg, bb] = [x, 0, c2];
  else [rr, gg, bb] = [c2, 0, x];
  const hx = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + hx(rr) + hx(gg) + hx(bb);
}

export const PRESET_COLOURS = [
  '#ff2020', '#ff8000', '#ffd400', '#40ff40',
  '#00e5ff', '#2060ff', '#a040ff', '#ff40c0', '#ffffff',
];
