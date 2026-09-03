// Offscreen rendering of the playfield, plus the LED sampling that turns
// pixels into light colours.
//
// Sampling walks the layers one at a time rather than reading a single
// composited frame. That costs one small bounding-box read per layer, and buys
// three things a composited read cannot give: light contributions accumulated
// in linear light (physically correct addition), per-layer light masks (tag
// targeting), and layers that contribute colours directly with no pixels at
// all (imported MPF shows).

import { SHAPE_BY_ID, shapeExtent } from './shapes.js';
import {
  layerStateAtTime, resolveShow, showFrameAt, mapShowToLights,
  orderedTargets, patternTimeAt, targetBounds, mulberry32, hashString,
  effectiveParams, hexToRgb, rgbToHex,
} from './project.js';

const D2R = Math.PI / 180;

// Fixed sampling resolution. Independent of window size so what you preview is
// bit-for-bit what you export.
export const RENDER_W = 480;

// sRGB <-> linear light. LEDs add in linear light; 8-bit sRGB values do not.
const TO_LINEAR = new Float32Array(256);
const TO_SRGB_ID = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  TO_SRGB_ID[i] = c;
}

function linearToSrgb255(v) {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
}

function identityToSrgb255(v) {
  return v <= 0 ? 0 : (v >= 1 ? 255 : v * 255);
}

const imageCache = new Map();

export function loadShapeImage(name) {
  if (!name) return null;
  if (imageCache.has(name)) return imageCache.get(name);
  const img = new Image();
  img.src = '/shapes/' + encodeURIComponent(name);
  imageCache.set(name, img);
  return img;
}

export function preloadShapeImages(names) {
  return Promise.all(names.map((n) => new Promise((res) => {
    const img = loadShapeImage(n);
    if (img.complete) return res();
    img.onload = () => res();
    img.onerror = () => res();
  })));
}

// ---------------------------------------------------------------------------
// light masking by tag
// ---------------------------------------------------------------------------

function targetKey(t) {
  if (!t) return 'all';
  const ex = (t.exclude || []).slice().sort().join(',');
  if (t.mode !== 'tags') return ex ? `all|-${ex}` : 'all';
  return `${t.match}|${t.invert ? 1 : 0}|${(t.tags || []).slice().sort().join(',')}|-${ex}`;
}

/** Uint8Array of 1/0 per light, or null when the layer affects everything. */
export function layerMask(layer, lights) {
  const t = layer.target;
  if (!t) return null;
  const tags = t.mode === 'tags' ? (t.tags || []) : [];
  const exclude = t.exclude || [];
  if (!tags.length && !exclude.length) return null;

  const key = targetKey(t);
  if (layer._maskKey === key && layer._maskFor === lights) return layer._mask;

  const set = new Set(tags);
  const exSet = new Set(exclude);
  const mask = new Uint8Array(lights.length);
  for (let i = 0; i < lights.length; i++) {
    const lt = lights[i].tags || [];
    let hit = true;
    if (tags.length) {
      if (t.match === 'all') {
        hit = tags.every((x) => lt.includes(x));
      } else {
        hit = false;
        for (const tag of lt) if (set.has(tag)) { hit = true; break; }
      }
      if (t.invert) hit = !hit;
    }
    // exclusions are applied last, so "these tags but not that one" is sayable
    if (hit && exSet.size) {
      for (const tag of lt) if (exSet.has(tag)) { hit = false; break; }
    }
    mask[i] = hit ? 1 : 0;
  }
  layer._mask = mask;
  layer._maskKey = key;
  layer._maskFor = lights;
  return mask;
}

/**
 * Map an imported show's light names onto the current light list.
 * Recomputed whenever the light map or the layer's remap mode changes, so a
 * show always plays against whatever map is loaded now.
 */
function showLightIndex(layer, lights) {
  const key = layer.remap || 'name';
  if (layer._showIdxFor === lights && layer._showIdxKey === key && layer._showIdx) {
    return layer._showIdx;
  }
  const report = mapShowToLights(layer, lights);
  if (!report) return null;
  layer._showIdx = report.index;
  layer._showIdxFor = lights;
  layer._showIdxKey = key;
  layer._showReport = report;
  return report.index;
}

/** Coverage of an imported show against the current light map. */
export function showCoverage(layer, lights) {
  showLightIndex(layer, lights);
  return layer._showReport || null;
}

// ---------------------------------------------------------------------------

const offsetCache = new Map();
function sampleOffsets(radius) {
  if (offsetCache.has(radius)) return offsetCache.get(radius);
  const pts = [];
  if (radius <= 0) {
    pts.push(0, 0);
  } else {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius) pts.push(dx, dy);
      }
    }
  }
  const arr = Int16Array.from(pts);
  offsetCache.set(radius, arr);
  return arr;
}

export class ShowRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.scratch = document.createElement('canvas');
    this.sctx = this.scratch.getContext('2d', { willReadFrequently: true });
    this.alphaCopy = document.createElement('canvas');
    this.actx = this.alphaCopy.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.accum = null;
    this.out = null;
    this.lastStats = { shapeLayers: 0, showLayers: 0 };
  }

  resize(aspect) {
    const w = RENDER_W;
    const h = Math.max(1, Math.round(RENDER_W / (aspect || 0.5)));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    for (const c of [this.canvas, this.scratch, this.alphaCopy]) {
      c.width = w; c.height = h;
    }
  }

  ensureBuffers(n) {
    if (!this.accum || this.accum.length !== n * 3) {
      this.accum = new Float32Array(n * 3);
      this.out = new Uint8ClampedArray(n * 3);
    }
  }

  /**
   * Draw the frame for display and sample every light, in one pass.
   * Returns the flat rgb array (also kept as `this.out`).
   */
  render(project, lights, timeMs, options) {
    const opts = options || project.export || {};
    const linear = (opts.blend || 'linear') !== 'srgb';
    const toLin = linear ? TO_LINEAR : TO_SRGB_ID;
    const fromLin = linear ? linearToSrgb255 : identityToSrgb255;

    this.resize(project.aspect);
    this.ensureBuffers(lights.length);
    this.accum.fill(0);

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.w, this.h);

    let shapeLayers = 0;
    let showLayers = 0;
    let patternLayers = 0;

    for (const layer of project.layers) {
      if (!layer.enabled) continue;
      const st = layerStateAtTime(layer, timeMs);

      if (layer.kind === 'show') {
        if (this.accumulateShow(layer, lights, timeMs, st, toLin)) showLayers++;
        continue;
      }
      if (layer.kind === 'pattern') {
        if (this.accumulatePattern(layer, lights, timeMs, st, toLin)) patternLayers++;
        continue;
      }
      if (!st || st.alpha <= 0) continue;
      if (this.drawAndAccumulate(layer, st, lights, opts, toLin)) shapeLayers++;
    }

    // linear (or plain) accumulation -> 8-bit sRGB, then the export post-process
    const gamma = opts.gamma && opts.gamma > 0 ? opts.gamma : 1;
    const minLevel = opts.minLevel || 0;
    const mode = opts.mode || 'colour';
    const threshold = opts.threshold == null ? 32 : opts.threshold;
    const out = this.out;

    for (let i = 0; i < lights.length * 3; i += 3) {
      let r = fromLin(this.accum[i]);
      let g = fromLin(this.accum[i + 1]);
      let b = fromLin(this.accum[i + 2]);

      if (gamma !== 1) {
        r = 255 * Math.pow(r / 255, gamma);
        g = 255 * Math.pow(g / 255, gamma);
        b = 255 * Math.pow(b / 255, gamma);
      }
      if (minLevel > 0) {
        if (r > 0 && r < minLevel) r = minLevel;
        if (g > 0 && g < minLevel) g = minLevel;
        if (b > 0 && b < minLevel) b = minLevel;
      }
      if (mode === 'bw') {
        const on = (r >= threshold || g >= threshold || b >= threshold);
        r = g = b = on ? 255 : 0;
      } else if (mode === 'threshold') {
        if (r < threshold) r = 0;
        if (g < threshold) g = 0;
        if (b < threshold) b = 0;
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
    }

    this.lastStats = { shapeLayers, showLayers, patternLayers };
    return out;
  }

  /** Render one shape layer, sample it, then composite it for display. */
  drawAndAccumulate(layer, st, lights, opts, toLin) {
    const def = SHAPE_BY_ID.get(layer.shapeId);
    if (!def) return false;

    const px = st.x * this.w;
    const py = st.y * this.h;
    const sizeX = Math.abs(st.sx) * this.w;
    const sizeY = Math.abs(st.sy) * this.w;
    if (sizeX < 0.01 || sizeY < 0.01) return false;

    // animated params change the shape's extent, so the bounding box has to
    // follow them or a growing shape would be clipped at its old size
    const params = effectiveParams(layer, st);
    const ext = shapeExtent(layer.shapeId, params);
    const rad = ext * Math.max(sizeX, sizeY) * 1.5 + 6;
    const bx = Math.max(0, Math.floor(px - rad));
    const by = Math.max(0, Math.floor(py - rad));
    const bw = Math.min(this.w - bx, Math.ceil(rad * 2 + 2));
    const bh = Math.min(this.h - by, Math.ceil(rad * 2 + 2));
    if (bw <= 0 || bh <= 0) return false;

    this.paintLayerToScratch(layer, st, def, px, py, sizeX, sizeY, params);

    // ---- sample this layer alone
    const mask = layerMask(layer, lights);
    const radius = Math.max(0, Math.round(opts.sampleRadius == null ? 2 : opts.sampleRadius));
    const offsets = sampleOffsets(radius);
    const total = offsets.length / 2;
    const alphaScale = Math.max(0, Math.min(1, st.alpha));
    const additive = layer.blend !== 'normal';
    const accum = this.accum;

    // Read a small tile around each light rather than the whole layer bounding
    // box. Only a few hundred pixels of a ~350k-pixel box are ever used, and
    // measured on a 15-layer show the tiles are several times faster.
    for (let i = 0; i < lights.length; i++) {
      if (mask && !mask[i]) continue;
      const cx = Math.round(lights[i].x * this.w);
      const cy = Math.round(lights[i].y * this.h);
      if (cx + radius < bx || cx - radius >= bx + bw) continue;
      if (cy + radius < by || cy - radius >= by + bh) continue;

      const rx = Math.max(0, cx - radius);
      const ry = Math.max(0, cy - radius);
      const rw = Math.min(this.w, cx + radius + 1) - rx;
      const rh = Math.min(this.h, cy + radius + 1) - ry;
      if (rw <= 0 || rh <= 0) continue;
      const d = this.sctx.getImageData(rx, ry, rw, rh).data;

      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let k = 0; k < offsets.length; k += 2) {
        const x = cx + offsets[k];
        const y = cy + offsets[k + 1];
        if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) continue;
        const p = ((y - ry) * rw + (x - rx)) * 4;
        const a = d[p + 3] / 255;
        if (a <= 0) continue;
        sr += toLin[d[p]] * a;
        sg += toLin[d[p + 1]] * a;
        sb += toLin[d[p + 2]] * a;
        sa += a;
      }
      if (sa <= 0) continue;

      const cov = (sa / total) * alphaScale;
      const j = i * 3;
      if (additive) {
        // premultiplied average over the sample disc
        accum[j] += (sr / total) * alphaScale;
        accum[j + 1] += (sg / total) * alphaScale;
        accum[j + 2] += (sb / total) * alphaScale;
      } else {
        const inv = 1 - cov;
        accum[j] = accum[j] * inv + (sr / sa) * cov;
        accum[j + 1] = accum[j + 1] * inv + (sg / sa) * cov;
        accum[j + 2] = accum[j + 2] * inv + (sb / sa) * cov;
      }
    }

    // ---- composite for the on-screen preview
    const target = this.ctx;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = alphaScale;
    target.globalCompositeOperation = additive ? 'lighter' : 'source-over';
    target.drawImage(this.scratch, bx, by, bw, bh, bx, by, bw, bh);
    target.restore();
    return true;
  }

  /** Shape mask + colour, left in this.scratch. */
  paintLayerToScratch(layer, st, def, px, py, sizeX, sizeY, params) {
    const s = this.sctx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, this.w, this.h);

    const applyTransform = (c) => {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.translate(px, py);
      c.rotate(st.rot * D2R);
      c.scale(sizeX, sizeY);
    };

    s.save();
    applyTransform(s);
    s.fillStyle = 'rgba(255,255,255,1)';
    s.strokeStyle = 'rgba(255,255,255,1)';
    s.lineWidth = 0.02;
    const env = def.isImage ? { image: loadShapeImage(layer.image) } : null;
    try {
      def.draw(s, params || effectiveParams(layer, st), env);
    } catch (err) {
      console.warn('shape draw failed', layer.shapeId, err);
    }
    s.restore();

    if (def.isImage) {
      // Preserve the image's own luminance the way the original SetColor did:
      // multiply the tint in, then restore the image's alpha.
      this.actx.setTransform(1, 0, 0, 1, 0, 0);
      this.actx.globalCompositeOperation = 'copy';
      this.actx.drawImage(this.scratch, 0, 0);

      s.save();
      s.globalCompositeOperation = 'multiply';
      applyTransform(s);
      s.fillStyle = this.buildPaint(s, layer, st);
      s.fillRect(-4, -4, 8, 8);
      s.restore();

      s.save();
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalCompositeOperation = 'destination-in';
      s.drawImage(this.alphaCopy, 0, 0);
      s.restore();
    } else {
      s.save();
      s.globalCompositeOperation = 'source-in';
      applyTransform(s);
      s.fillStyle = this.buildPaint(s, layer, st);
      s.fillRect(-4, -4, 8, 8);
      s.restore();
    }
  }

  /** An imported MPF show contributes light colours with no pixels involved. */
  accumulateShow(layer, lights, timeMs, st, toLin) {
    const frame = showFrameAt(layer, timeMs);
    if (frame < 0) return false;
    const resolved = resolveShow(layer);
    const idx = showLightIndex(layer, lights);
    if (!resolved || !idx) return false;

    const mask = layerMask(layer, lights);
    const alphaScale = st ? Math.max(0, Math.min(1, st.alpha)) : 1;
    if (alphaScale <= 0) return false;
    const additive = layer.blend !== 'normal';
    const accum = this.accum;
    const base = frame * resolved.stride;

    for (let i = 0; i < idx.length; i++) {
      const j = idx[i];
      if (j < 0) continue;
      if (mask && !mask[j]) continue;
      const p = base + i * 3;
      const r = toLin[resolved.data[p]] * alphaScale;
      const g = toLin[resolved.data[p + 1]] * alphaScale;
      const b = toLin[resolved.data[p + 2]] * alphaScale;
      const k = j * 3;
      if (additive) {
        accum[k] += r; accum[k + 1] += g; accum[k + 2] += b;
      } else {
        const inv = 1 - alphaScale;
        accum[k] = accum[k] * inv + r;
        accum[k + 1] = accum[k + 1] * inv + g;
        accum[k + 2] = accum[k + 2] * inv + b;
      }
    }
    return true;
  }

  /**
   * A blink/chase pattern, applied straight to the targeted lights.
   * No canvas involved, so the colours land exactly as written.
   */
  accumulatePattern(layer, lights, timeMs, st, toLin) {
    const p = layer.pattern;
    if (!p) return false;
    const t = patternTimeAt(layer, timeMs);
    if (t === null) return false;
    const alphaScale = st ? Math.max(0, Math.min(1, st.alpha)) : 1;
    if (alphaScale <= 0) return false;

    const mask = layerMask(layer, lights);
    const additive = layer.blend !== 'normal';
    const accum = this.accum;

    const put = (lightIndex, hex, gain) => {
      const c = hexToRgb(hex);
      const k = lightIndex * 3;
      const r = toLin[c.r] * alphaScale * gain;
      const g = toLin[c.g] * alphaScale * gain;
      const b = toLin[c.b] * alphaScale * gain;
      if (additive) {
        accum[k] += r; accum[k + 1] += g; accum[k + 2] += b;
      } else {
        const inv = 1 - alphaScale * gain;
        accum[k] = accum[k] * inv + r;
        accum[k + 1] = accum[k + 1] * inv + g;
        accum[k + 2] = accum[k + 2] * inv + b;
      }
    };

    if (p.type === 'sparkle') {
      const order = orderedTargets(layer, lights, mask);
      const n = order.length;
      if (!n) return false;
      const stepMs = Math.max(1, p.stepMs);
      const count = Math.max(1, Math.min(n, Math.round(p.count)));
      const life = Math.max(1, Math.round(p.life));
      const palette = (p.colors && p.colors.length) ? p.colors : [p.color];
      const step = Math.floor(t / stepMs);
      const phase = (t - step * stepMs) / stepMs;      // 0..1 through the step
      // seedKey survives being saved as an effect and re-inserted; a plain
      // layer has none and falls back to its id, so two sparkles still differ
      const base = hashString(layer.seedKey || layer.id) ^ ((p.seed | 0) * 2654435761);

      // Every generation still alive contributes, so `life > 1` leaves trails.
      for (let age = 0; age < life; age++) {
        const gen = step - age;
        if (gen < 0) continue;
        const rand = mulberry32((base ^ (gen * 0x9E3779B1)) >>> 0);
        // partial Fisher-Yates over a scratch copy: distinct picks, no rejection
        const pool = order.slice();
        for (let k = 0; k < count; k++) {
          const j = k + Math.floor(rand() * (pool.length - k));
          const tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
          const hex = palette[Math.floor(rand() * palette.length) % palette.length];
          // brightness falls from 1 to 0 across the sparkle's whole life
          const u = (age + phase) / life;
          const gain = p.decay > 0 ? Math.max(0, 1 - u * p.decay) * (u >= 1 ? 0 : 1) : 1;
          if (gain > 0) put(pool[k], hex, gain);
        }
      }
      return true;
    }

    if (p.type === 'wavy') {
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const period = Math.max(1, p.periodMs);
      const lambda = Math.max(0.02, p.wavelength);
      const phase = t / period;
      const floor = Math.max(0, Math.min(1, p.floorLevel));
      const sharp = Math.max(0.1, p.sharpness);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        let pos;
        if (p.axis === 'x') pos = (l.x - b.minX) / b.w;
        else if (p.axis === 'radial') {
          const dx = (l.x - cx) / b.w, dy = (l.y - cy) / b.h;
          pos = Math.sqrt(dx * dx + dy * dy) * 2;
        } else pos = (l.y - b.minY) / b.h;

        const s = Math.sin(2 * Math.PI * (pos / lambda - phase));
        let level = (s + 1) / 2;                 // 0..1
        if (sharp !== 1) level = Math.pow(level, sharp);
        level = floor + (1 - floor) * level;
        if (level > 0.002) put(i, p.color, level);
      }
      return true;
    }

    if (p.type === 'stack') {
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const cols = Math.max(1, Math.round(p.cols));
      const rows = Math.max(1, Math.round(p.rows));
      const cells = cols * rows;
      const fillMs = Math.max(1, p.fillMs);
      const filled = Math.min(cells, (t / fillMs) * cells);

      // Cell fill order. Tetris-style is bottom row first, left to right.
      const cellRank = (col, row) => {
        if (p.fillOrder === 'top-down') return row * cols + col;
        if (p.fillOrder === 'left-right') return col * rows + row;
        if (p.fillOrder === 'right-left') return (cols - 1 - col) * rows + row;
        return (rows - 1 - row) * cols + col;         // bottom-up
      };

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        const col = Math.min(cols - 1, Math.floor(((l.x - b.minX) / b.w) * cols));
        const row = Math.min(rows - 1, Math.floor(((l.y - b.minY) / b.h) * rows));
        const rank = cellRank(col, row);
        if (rank >= filled) continue;
        if (p.fillMode === 'wipe' && rank < filled - 1) continue;
        // blend the two colours across the fill so the stack has depth
        const u = cells > 1 ? rank / (cells - 1) : 0;
        const ca = hexToRgb(p.color);
        const cb = hexToRgb(p.color2 || p.color);
        const hex = rgbToHex(ca.r + (cb.r - ca.r) * u,
                             ca.g + (cb.g - ca.g) * u,
                             ca.b + (cb.b - ca.b) * u);
        // the cell arriving right now eases in rather than popping
        const gain = Math.min(1, (filled - rank));
        put(i, hex, gain);
      }
      return true;
    }

    if (p.type === 'chase') {
      const order = orderedTargets(layer, lights, mask);
      const n = order.length;
      if (!n) return false;
      const stepMs = Math.max(1, p.stepMs);
      const head = Math.floor(t / stepMs);
      const width = Math.max(1, Math.round(p.width));
      const tail = Math.max(0, Math.round(p.tail));
      for (let w = 0; w < width; w++) {
        put(order[(((head + w) % n) + n) % n], p.color, 1);
      }
      for (let d = 1; d <= tail; d++) {
        const gain = 1 - d / (tail + 1);
        put(order[(((head - d) % n) + n) % n], p.color, gain);
      }
      return true;
    }

    // blink and solid both come down to "which colour right now"
    let hex = p.color;
    if (p.type === 'blink') {
      const on = Math.max(1, p.onMs);
      const off = Math.max(0, p.offMs);
      const period = on + off;
      const phase = period > 0 ? t % period : 0;
      if (phase >= on) {
        if (p.offMode !== 'colour') return true;   // dark: contribute nothing
        hex = p.offColor;
      }
    }
    for (let i = 0; i < lights.length; i++) {
      if (mask && !mask[i]) continue;
      put(i, hex, 1);
    }
    return true;
  }

  /** fillStyle for the colour pass, built in the shape's own unit space. */
  buildPaint(ctx, layer, st) {
    if (layer.colorMode === 'gradient') {
      const g = ctx.createLinearGradient(-0.5, 0, 0.5, 0);
      g.addColorStop(0, st.color);
      g.addColorStop(1, st.color2 || st.color);
      return g;
    }
    if (layer.colorMode === 'rainbow') {
      const spread = layer.rainbowSpread == null ? 360 : layer.rainbowSpread;
      const offset = layer.rainbowOffset || 0;
      const stops = 12;
      if (typeof ctx.createConicGradient === 'function') {
        const g = ctx.createConicGradient(0, 0, 0);
        for (let i = 0; i <= stops; i++) {
          g.addColorStop(i / stops, `hsl(${offset + (i / stops) * spread} 100% 50%)`);
        }
        return g;
      }
      const g = ctx.createLinearGradient(-0.5, 0, 0.5, 0);
      for (let i = 0; i <= stops; i++) {
        g.addColorStop(i / stops, `hsl(${offset + (i / stops) * spread} 100% 50%)`);
      }
      return g;
    }
    return st.color;
  }

  /** Draw one layer state into an arbitrary context. Used for onion skinning. */
  drawLayer(layer, st, opts = {}) {
    if (layer.kind !== 'shape') return;
    const def = SHAPE_BY_ID.get(layer.shapeId);
    if (!def) return;
    const px = st.x * this.w;
    const py = st.y * this.h;
    const sizeX = Math.abs(st.sx) * this.w;
    const sizeY = Math.abs(st.sy) * this.w;
    if (sizeX < 0.01 || sizeY < 0.01) return;

    this.paintLayerToScratch(layer, st, def, px, py, sizeX, sizeY,
      effectiveParams(layer, st));

    const target = opts.ctx || this.ctx;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = Math.max(0, Math.min(1, st.alpha)) * (opts.alphaScale == null ? 1 : opts.alphaScale);
    target.globalCompositeOperation = layer.blend === 'normal' ? 'source-over' : 'lighter';
    target.drawImage(this.scratch, 0, 0);
    target.restore();
  }
}

// ---------------------------------------------------------------------------
// Light drawing (display only)
// ---------------------------------------------------------------------------

const LIGHT_POLYS = {
  circle: null, // drawn as an arc
  square: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
  rectangle: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]],
  diamond: [[0, -1], [1, 0], [0, 1], [-1, 0]],
  triangle: [[0, -1], [0.87, 0.6], [-0.87, 0.6]],
  arrow: [[0, -1], [0.8, 0.3], [0.3, 0.3], [0.3, 1], [-0.3, 1], [-0.3, 0.3], [-0.8, 0.3]],
  flipper: [[0, 0], [-2.2, 0.55], [-2.2, -0.55]],
  star: [[0, -1], [0.29, -0.31], [0.95, -0.31], [0.47, 0.12], [0.59, 0.81],
    [0, 0.38], [-0.59, 0.81], [-0.47, 0.12], [-0.95, -0.31], [-0.29, -0.31]],
};

export function lightPath(ctx, light, r) {
  const shape = LIGHT_POLYS[light.shape] === undefined ? 'circle' : light.shape;
  const poly = LIGHT_POLYS[shape];
  ctx.beginPath();
  if (!poly) {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    return;
  }
  ctx.moveTo(poly[0][0] * r, poly[0][1] * r);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] * r, poly[i][1] * r);
  ctx.closePath();
}

/**
 * Draw the light overlay onto a display context.
 * `colors` is the flat rgb array (may be null for an unlit view).
 */
export function drawLights(ctx, lights, colors, view) {
  const { w, h, sizeScale, showOff, glow, selected, dimmed } = view;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    const x = l.x * w;
    const y = l.y * h;
    const r = Math.max(1.5, (l.size || 0.05) * 0.366 * w * (sizeScale || 1));
    const cr = colors ? colors[i * 3] : 0;
    const cg = colors ? colors[i * 3 + 1] : 0;
    const cb = colors ? colors[i * 3 + 2] : 0;
    const lit = cr + cg + cb > 6;
    const outOfScope = dimmed && !dimmed[i];

    ctx.save();
    ctx.translate(x, y);
    if (l.rotation) ctx.rotate((l.rotation + 270) * D2R);

    if (lit && glow) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 3);
      g.addColorStop(0, `rgba(${cr | 0},${cg | 0},${cb | 0},0.5)`);
      g.addColorStop(1, `rgba(${cr | 0},${cg | 0},${cb | 0},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    lightPath(ctx, l, r);
    if (lit) {
      ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      ctx.fill();
    } else if (showOff) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
    }
    ctx.lineWidth = 1;
    if (selected && selected.has(i)) ctx.strokeStyle = 'rgba(120,220,255,0.95)';
    else if (outOfScope) ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    else if (dimmed) ctx.strokeStyle = 'rgba(255,183,77,0.75)';
    else ctx.strokeStyle = lit ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.22)';
    ctx.stroke();
    ctx.restore();
  }
}

export function colorsToHex(colors, i) {
  return rgbToHex(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
}

export { hexToRgb };
