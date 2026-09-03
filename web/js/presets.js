// Ready-made layers. Each one is a complete, playable effect that you can drop
// in and then tweak, rather than starting from a bare shape every time.

import { makeLayer, makeKey, makePatternLayer } from './project.js';
import { shapeDefaults } from './shapes.js';

const S = (id, over) => Object.assign(shapeDefaults(id), over || {});

/**
 * Order the preset dialog lists groups in. Patterns come first because they
 * light the lights directly - they are the ones that read well on a sparse
 * playfield - and the shape-based groups follow.
 */
export const GROUP_ORDER = ['Patterns', 'Wipes', 'Radial', 'Flashes'];

export const PRESETS = [
  {
    id: 'chase-names',
    name: 'Chase',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Chase', durationMs: 3000,
      pattern: { type: 'chase', color: c, stepMs: 120, width: 1, tail: 2, order: 'name' },
    }),
  },

  {
    id: 'chase-updown',
    name: 'Chase up',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Chase up', durationMs: 3000,
      pattern: { type: 'chase', color: c, stepMs: 100, width: 2, tail: 3,
                 order: 'y', reverse: true },
    }),
  },

  {
    id: 'marquee',
    name: 'Marquee',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Marquee', durationMs: 3000,
      pattern: { type: 'marquee', color: c, every: 3, marqueeMs: 140, order: 'name' },
    }),
  },

  {
    id: 'fire',
    name: 'Fire',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Fire', durationMs: 4000,
      pattern: {
        type: 'fire', color: c, color2: '#401000',
        fireMs: 90, fireHeat: 0.8, fireJitter: 0.45,
      },
    }),
  },

  {
    id: 'pinwheel',
    name: 'Pinwheel',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Pinwheel', durationMs: 3000,
      pattern: { type: 'pinwheel', color: c, arms: 3, spinMs: 2000, armWidth: 0.35 },
    }),
  },

  {
    id: 'scanner',
    name: 'Scanner',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Scanner', durationMs: 2800,
      pattern: { type: 'scanner', color: c, axis: 'y', sweepMs: 1400, bandWidth: 0.22, tailLen: 0.25 },
    }),
  },

  {
    id: 'rain',
    name: 'Rain',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Rain', durationMs: 4000,
      pattern: { type: 'rain', color: c, drops: 6, dropMs: 1400, tailLen: 0.25 },
    }),
  },

  {
    id: 'plasma',
    name: 'Plasma',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Plasma', durationMs: 5000,
      pattern: { type: 'plasma', color: c, color2: '#2060ff', plasmaScale: 2.2, plasmaMs: 3000 },
    }),
  },

  {
    id: 'contagion',
    name: 'Contagion',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Contagion', durationMs: 3000,
      pattern: { type: 'contagion', color: c, spreadMs: 3000, spreadFrom: 'bottom',
        spreadRadius: 0.18, spreadHold: true },
    }),
  },

  {
    id: 'comet',
    name: 'Comet',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Comet', durationMs: 3000,
      pattern: { type: 'comet', color: c, comets: 2, cometMs: 2500,
        launchSpeed: 1.6, gravity: 3.2, bounceDamp: 0.62 },
    }),
  },

  {
    id: 'sweep-tags',
    name: 'Group sweep',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Group sweep', durationMs: 2400,
      pattern: { type: 'sweep', color: c, dwellMs: 400, crossfade: 0.35 },
    }),
  },

  {
    id: 'interference',
    name: 'Interference',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Interference', durationMs: 5000,
      pattern: { type: 'interference', color: c, axis: 'radial',
        wavelength: 0.5, wavelength2: 0.62, periodMs: 2500 },
    }),
  },

  {
    id: 'voronoi',
    name: 'Territories',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Territories', durationMs: 6000,
      pattern: { type: 'voronoi', color: c, seeds: 4, voronoiMs: 6000,
        voronoiDrift: 0.22 },
    }),
  },

  {
    id: 'breathe',
    name: 'Breathe',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Breathe', durationMs: 4000,
      pattern: { type: 'solid', color: c, pulseShape: 'breathe', pulseMs: 2000 },
    }),
  },

  {
    id: 'heartbeat',
    name: 'Heartbeat',
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Heartbeat', durationMs: 4000,
      pattern: { type: 'solid', color: c, pulseShape: 'heartbeat', pulseMs: 1100 },
    }),
  },

  {
    id: 'sparkle',
    name: 'Sparkle',
    group: 'Patterns',
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
    group: 'Patterns',
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
    group: 'Patterns',
    pattern: true,
    build: (c) => makePatternLayer({
      name: 'Stack', durationMs: 2000,
      pattern: { type: 'stack', color: c, color2: '#ffffff', cols: 4, rows: 6,
                 fillMs: 2000, fillOrder: 'bottom-up', fillMode: 'fill' },
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
