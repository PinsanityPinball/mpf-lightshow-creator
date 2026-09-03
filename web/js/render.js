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
  orderedTargets, patternTimeAt, patternTimesAt, targetBounds, mulberry32, hashString,
  effectiveParams, hexToRgb, rgbToHex,
  layerInstancesAtTime,
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
      // Averaging layers cannot be folded into `accum` as they go: a mean needs
      // to know how many layers reached each light, which is only true once
      // every layer has had its turn. They collect here and resolve at the end.
      this.avgSum = new Float32Array(n * 3);
      this.avgCount = new Float32Array(n);
      this.avgPeak = new Float32Array(n);
    }
  }

  /** One averaging layer's contribution to a light, in linear light. */
  addAverage(i, r, g, b) {
    this.avgPending = true;
    const k = i * 3;
    this.avgSum[k] += r;
    this.avgSum[k + 1] += g;
    this.avgSum[k + 2] += b;
    this.avgCount[i] += 1;
    // the brightest single contributor sets the level the mean is scaled back
    // up to, so averaging changes the colour without dimming the light
    const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (m > this.avgPeak[i]) this.avgPeak[i] = m;
  }

  /**
   * Fold the averaging group into the main accumulator.
   *
   * Red and blue average to a half-bright purple, which on a playfield reads as
   * "the light went dim" rather than "the light went purple". Rescaling the
   * mean so its brightest channel matches the brightest contributor keeps the
   * hue the average produced and the brightness the layers asked for.
   */
  resolveAverage(n) {
    if (!this.avgPending) return;
    this.avgPending = false;
    for (let i = 0; i < n; i++) {
      const c = this.avgCount[i];
      if (!c) continue;
      const k = i * 3;
      let r = this.avgSum[k] / c;
      let g = this.avgSum[k + 1] / c;
      let b = this.avgSum[k + 2] / c;
      const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (m > 0) {
        const scale = this.avgPeak[i] / m;
        r *= scale; g *= scale; b *= scale;
      }
      // the averaged group then stacks with everything that is not averaging
      this.accum[k] += r;
      this.accum[k + 1] += g;
      this.accum[k + 2] += b;
      // reset so a later group averages on its own terms
      this.avgSum[k] = 0; this.avgSum[k + 1] = 0; this.avgSum[k + 2] = 0;
      this.avgCount[i] = 0;
      this.avgPeak[i] = 0;
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
    this.avgSum.fill(0);
    this.avgCount.fill(0);
    this.avgPeak.fill(0);
    this.avgPending = false;

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

      // Erase and Normal work by reading and rewriting `accum`, but averaging
      // layers do not reach `accum` until their group is resolved. Resolving
      // early - right before a layer that reads it - is what makes "erase only
      // affects the layers below it" true for averaged layers too.
      //
      // Only for a layer that is actually playing, though: flushing on blend
      // alone let a finished eraser sitting between two averaging layers split
      // them into two groups, which sum instead of averaging and come out a
      // different colour despite the eraser contributing nothing.
      const mutates = layer.blend === 'erase' || layer.blend === 'normal';

      if (layer.kind === 'show') {
        const st = layerStateAtTime(layer, timeMs);
        if (!st) continue;
        if (mutates) this.resolveAverage(lights.length);
        if (this.accumulateShow(layer, lights, timeMs, st, toLin)) showLayers++;
        continue;
      }
      if (layer.kind === 'pattern') {
        const fires = patternTimesAt(layer, timeMs);
        if (!fires.length) continue;
        if (mutates) this.resolveAverage(lights.length);
        const st = layerStateAtTime(layer, timeMs);
        let ran = false;
        for (const f of fires) {
          if (this.accumulatePattern(layer, lights, timeMs, st, toLin, f.t)) ran = true;
        }
        if (ran) patternLayers++;
        continue;
      }

      // A layer with extra fire times is drawn once per firing that is alive
      // now. They overlap freely: a 1s gesture fired every 200ms has five of
      // itself on screen, which is the reason the feature exists.
      const live = layerInstancesAtTime(layer, timeMs)
        .filter((inst) => inst.state && inst.state.alpha > 0);
      if (!live.length) continue;
      if (mutates) this.resolveAverage(lights.length);
      let drew = false;
      for (const inst of live) {
        if (this.drawAndAccumulate(layer, inst.state, lights, opts, toLin)) drew = true;
      }
      if (drew) shapeLayers++;
    }

    this.resolveAverage(lights.length);

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
    const erasing = layer.blend === 'erase';
    const averaging = layer.blend === 'average';
    const additive = !erasing && !averaging && layer.blend !== 'normal';
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
      if (erasing) {
        // An eraser turns lights off wherever it covers them. Its own colour is
        // irrelevant - only how much of the light it covers matters - and it
        // only affects layers below it, since accumulation runs in layer order.
        const keep = 1 - cov;
        accum[j] *= keep; accum[j + 1] *= keep; accum[j + 2] *= keep;
      } else if (averaging) {
        this.addAverage(i, (sr / total) * alphaScale,
                        (sg / total) * alphaScale, (sb / total) * alphaScale);
      } else if (additive) {
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
    // The display canvas has no per-light accumulator to average into, so an
    // averaging layer is drawn additively there. The sampled output - what
    // actually reaches the machine - is the averaged result either way.
    target.globalCompositeOperation = erasing ? 'destination-out'
      : ((additive || averaging) ? 'lighter' : 'source-over');
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
    const erasing = layer.blend === 'erase';
    const averaging = layer.blend === 'average';
    const additive = !erasing && !averaging && layer.blend !== 'normal';
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
      if (erasing) {
        // brightness of the imported show decides how hard it erases
        const lum = Math.max(r, g, b);
        const keep = 1 - Math.max(0, Math.min(1, lum));
        accum[k] *= keep; accum[k + 1] *= keep; accum[k + 2] *= keep;
      } else if (averaging) {
        this.addAverage(j, r, g, b);
      } else if (additive) {
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
   * A period that divides the clip evenly.
   *
   * A pattern's own timing has nothing to do with how long its layer runs, so
   * stretching a clip used to leave the pattern finishing early and holding, or
   * cut mid-cycle and jump on the repeat. Rounding to a whole number of cycles
   * fixes both, at the cost of running fractionally faster or slower than the
   * number typed in.
   */
  fitPeriod(layer, wanted, on) {
    const want = Math.max(1, wanted);
    if (!on || !(layer.durationMs > 0)) return want;
    // A clip shorter than the period cannot hold a whole cycle. Rounding up to
    // one anyway made a 200ms clip run a 3000ms plasma fifteen times too fast,
    // which is not "fractionally" off. Below one cycle, keep the speed that was
    // asked for and let the clip simply cut it short.
    if (layer.durationMs < want) return want;
    const cycles = Math.max(1, Math.round(layer.durationMs / want));
    return layer.durationMs / cycles;
  }

  /**
   * A blink/chase pattern, applied straight to the targeted lights.
   * No canvas involved, so the colours land exactly as written.
   */
  accumulatePattern(layer, lights, timeMs, st, toLin, localT) {
    const p = layer.pattern;
    if (!p) return false;
    // localT lets the caller run one specific firing of an instanced layer;
    // without it the layer's own single firing is used
    const t = localT == null ? patternTimeAt(layer, timeMs) : localT;
    if (t === null) return false;
    const alphaScale = st ? Math.max(0, Math.min(1, st.alpha)) : 1;
    if (alphaScale <= 0) return false;

    const mask = layerMask(layer, lights);
    const erasing = layer.blend === 'erase';
    const averaging = layer.blend === 'average';
    const additive = !erasing && !averaging && layer.blend !== 'normal';
    const accum = this.accum;

    const put = (lightIndex, hex, gain) => {
      const c = hexToRgb(hex);
      const k = lightIndex * 3;
      if (erasing) {
        // the pattern's shape decides which lights go off, not its colour
        const keep = 1 - Math.max(0, Math.min(1, alphaScale * gain));
        accum[k] *= keep; accum[k + 1] *= keep; accum[k + 2] *= keep;
        return;
      }
      const r = toLin[c.r] * alphaScale * gain;
      const g = toLin[c.g] * alphaScale * gain;
      const b = toLin[c.b] * alphaScale * gain;
      if (averaging) {
        this.addAverage(lightIndex, r, g, b);
        return;
      }
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
      // seedKey survives a save and reload; a plain layer has none and falls
      // back to its id, so two sparkles in one show still differ
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
      const period = this.fitPeriod(layer, p.periodMs, p.fit !== false);
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
        const bright = floor + (1 - floor) * level;
        if (bright <= 0.002) continue;
        // With a trough colour the wave washes between two colours rather than
        // just dimming, which needs a floor above 0 to be visible at all.
        let hex = p.color;
        if (p.waveColor2) {
          const ca = hexToRgb(p.waveColor2);
          const cb = hexToRgb(p.color);
          hex = rgbToHex(ca.r + (cb.r - ca.r) * level,
                         ca.g + (cb.g - ca.g) * level,
                         ca.b + (cb.b - ca.b) * level);
        }
        put(i, hex, bright);
      }
      return true;
    }

    if (p.type === 'stack') {
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const cols = Math.max(1, Math.round(p.cols));
      const rows = Math.max(1, Math.round(p.rows));
      const cells = cols * rows;
      // Fit means one complete fill over the clip. A stack that reached the top
      // early then sat there was the most obvious case of a pattern ignoring
      // how long its layer runs.
      const fillMs = p.fit !== false && layer.durationMs > 0
        ? layer.durationMs
        : Math.max(1, p.fillMs);
      const filled = Math.min(cells, (t / fillMs) * cells);

      // Cell fill order. Tetris-style is bottom row first, left to right.
      const cellRank = (col, row) => {
        if (p.fillOrder === 'top-down') return row * cols + col;
        if (p.fillOrder === 'left-right') return col * rows + row;
        if (p.fillOrder === 'right-left') return (cols - 1 - col) * rows + row;
        return (rows - 1 - row) * cols + col;         // bottom-up
      };

      // The inverse of cellRank, so the piece currently being placed can be
      // followed to where it is going. Without this the stack simply appeared a
      // cell at a time; watching it travel is what makes it read as falling.
      const rankCell = (rank) => {
        if (p.fillOrder === 'top-down') return { col: rank % cols, row: Math.floor(rank / cols) };
        if (p.fillOrder === 'left-right') return { col: Math.floor(rank / rows), row: rank % rows };
        if (p.fillOrder === 'right-left') {
          return { col: cols - 1 - Math.floor(rank / rows), row: rank % rows };
        }
        return { col: rank % cols, row: rows - 1 - Math.floor(rank / cols) };
      };

      const cellColour = (rank) => {
        const u = cells > 1 ? rank / (cells - 1) : 0;
        const ca = hexToRgb(p.color);
        const cb = hexToRgb(p.color2 || p.color);
        return rgbToHex(ca.r + (cb.r - ca.r) * u,
                        ca.g + (cb.g - ca.g) * u,
                        ca.b + (cb.b - ca.b) * u);
      };

      // Where the piece being placed has got to on its way in. It enters from
      // the edge the fill order comes from and travels to its resting cell.
      let moving = null;
      if (p.drop !== false && filled < cells) {
        const rank = Math.floor(filled);
        const frac = filled - rank;
        const target = rankCell(rank);
        // A piece enters from the edge the stack is growing AWAY from, so it
        // always travels over empty cells. Entering from a fixed edge meant a
        // top-down stack sent its pieces down through the rows it had already
        // filled, where they were hidden - only bottom-up ever showed a fall.
        if (p.fillOrder === 'left-right') {
          const from = cols - 1;
          moving = { rank, col: Math.round(from + (target.col - from) * frac), row: target.row };
        } else if (p.fillOrder === 'right-left') {
          const from = 0;
          moving = { rank, col: Math.round(from + (target.col - from) * frac), row: target.row };
        } else if (p.fillOrder === 'top-down') {
          const from = rows - 1;                            // rises from the bottom
          moving = { rank, col: target.col, row: Math.round(from + (target.row - from) * frac) };
        } else {
          const from = 0;                                   // bottom-up: falls from the top
          moving = { rank, col: target.col, row: Math.round(from + (target.row - from) * frac) };
        }
      }

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        const col = Math.min(cols - 1, Math.floor(((l.x - b.minX) / b.w) * cols));
        const row = Math.min(rows - 1, Math.floor(((l.y - b.minY) / b.h) * rows));
        const rank = cellRank(col, row);
        if (moving && col === moving.col && row === moving.row && rank >= filled) {
          put(i, cellColour(moving.rank), Math.max(0, Math.min(1, p.dropTrail)));
          continue;
        }
        if (rank >= filled) continue;
        if (p.fillMode === 'wipe' && rank < filled - 1) continue;
        // the cell arriving right now eases in rather than popping
        const gain = Math.min(1, (filled - rank));
        put(i, cellColour(rank), gain);
      }
      return true;
    }

    if (p.type === 'marquee') {
      // The classic theatre sign: every Nth light on, and the lit set steps
      // along one place at a time. Reads as movement without a moving shape.
      const order = orderedTargets(layer, lights, mask);
      const n = order.length;
      if (!n) return false;
      const every = Math.max(2, Math.round(p.every));
      // fit = a whole number of complete cycles, a cycle being `every` steps
      const stepMs = p.fit !== false && layer.durationMs > 0
        ? Math.max(1, this.fitPeriod(layer, p.marqueeMs * every, true) / every)
        : Math.max(1, p.marqueeMs);
      const raw = Math.floor(t / stepMs) % every;
      const shift = p.reverse ? (every - raw) % every : raw;
      for (let j = 0; j < n; j++) {
        const lit = ((j - shift) % every + every) % every === 0;
        if (lit) put(order[j], p.color, 1);
        else if (p.offMode === 'colour') put(order[j], p.offColor, 1);
      }
      return true;
    }

    if (p.type === 'fire') {
      // Per-light flicker on a warm ramp, hottest low down and cooling as it
      // rises. No geometry at all - the character comes from noise, which is
      // what makes it read differently from every other pattern here.
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const period = this.fitPeriod(layer, p.fireMs, p.fit !== false);
      const base = hashString(layer.seedKey || layer.id) ^ ((p.seed | 0) * 2654435761);
      const heat = Math.max(0, Math.min(1, p.fireHeat));
      const jitter = Math.max(0, Math.min(1, p.fireJitter));
      const ca = hexToRgb(p.color);            // the hot colour, low down
      const cb = hexToRgb(p.color2 || p.color); // the cool colour, up top

      // two offset sample points per light, blended, so the flicker moves
      // smoothly rather than stepping
      const u = (t / period) % 1;
      const step = Math.floor(t / period);
      const blend = u;

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        const ly = (l.y - b.minY) / (b.h || 1);
        const r1 = mulberry32((base ^ (i * 0x9E3779B1) ^ (step * 0x85EBCA6B)) >>> 0)();
        const r2 = mulberry32((base ^ (i * 0x9E3779B1) ^ ((step + 1) * 0x85EBCA6B)) >>> 0)();
        const noise = r1 + (r2 - r1) * blend;

        // y grows downward, so 1 - ly is height above the base of the group
        const up = 1 - ly;
        let level = heat * (1 - up * 0.85) + noise * jitter - up * 0.15;
        level = Math.max(0, Math.min(1, level));
        if (level <= 0.01) continue;
        const hex = rgbToHex(ca.r + (cb.r - ca.r) * (1 - level),
                             ca.g + (cb.g - ca.g) * (1 - level),
                             ca.b + (cb.b - ca.b) * (1 - level));
        put(i, hex, level);
      }
      return true;
    }

    if (p.type === 'pinwheel') {
      // Arms rotating about the centre. Radar sweep does something similar with
      // a drawn shape; this uses the light angles directly, so it stays even
      // however the lights are scattered.
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const period = this.fitPeriod(layer, p.spinMs, p.fit !== false);
      const arms = Math.max(1, Math.round(p.arms));
      const wide = Math.max(0.02, Math.min(1, p.armWidth));
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const dir = p.reverse ? -1 : 1;

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        const ang = Math.atan2((l.y - cy) / (b.h || 1), (l.x - cx) / (b.w || 1));
        const u = (ang / (Math.PI * 2) + 1) % 1;              // 0..1 around
        const phase = (u * arms - dir * (t / period) * arms) % 1;
        const f = (phase + 1) % 1;
        if (f > wide) continue;
        const level = 1 - f / wide;                            // bright leading edge
        if (level > 0.004) put(i, p.color, level);
      }
      return true;
    }

    if (p.type === 'scanner') {
      // The Knight Rider band: a soft bar sweeping back and forth with a tail.
      // Positional, so it sweeps the real playfield rather than a light index.
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const period = this.fitPeriod(layer, p.sweepMs, p.fit !== false);
      const width = Math.max(0.02, p.bandWidth);
      const bounce = p.bounce !== false;
      let u = (t / period) % 1;
      // Reversing a bounce by mirroring time does nothing: a triangle wave is
      // symmetric, so head(1-u) === head(u). Half a period starts it at the far
      // end travelling the other way, which is what reversing a bounce means.
      // A wrapping sweep has no such symmetry and does mirror.
      if (p.reverse) u = bounce ? (u + 0.5) % 1 : 1 - u;
      const head = bounce ? (u < 0.5 ? u * 2 : 2 - u * 2) : u;
      // Which way the head is moving right now, so the trail falls behind it.
      // For a bounce that is the half of the cycle we are in; for a wrap it is
      // fixed, and reversed when reverse is on.
      const dir = bounce ? (u < 0.5 ? 1 : -1) : (p.reverse ? -1 : 1);
      const tail = Math.max(0, Math.min(1, p.tailLen));

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        const pos = p.axis === 'x'
          ? (l.x - b.minX) / (b.w || 1)
          : (l.y - b.minY) / (b.h || 1);
        const gap = pos - head;
        const behind = gap * -dir;                    // positive = in the tail
        let level = 0;
        if (Math.abs(gap) < width) level = 1 - Math.abs(gap) / width;
        else if (tail > 0 && behind > 0 && behind < tail) level = (1 - behind / tail) * 0.55;
        if (level > 0.004) put(i, p.color, level);
      }
      return true;
    }

    if (p.type === 'rain') {
      // Drops falling down the playfield, each with a trail. Seeded from the
      // layer, so it replays identically and the export matches the preview.
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const period = this.fitPeriod(layer, p.dropMs, p.fit !== false);
      const n = Math.max(1, Math.round(p.drops));
      const tail = Math.max(0.02, p.tailLen);
      const base = hashString(layer.seedKey || layer.id) ^ ((p.seed | 0) * 2654435761);

      // each drop keeps a fixed column and a fixed offset into the cycle
      const cols = [];
      for (let k = 0; k < n; k++) {
        const rand = mulberry32((base ^ (k * 0x9E3779B1)) >>> 0);
        cols.push({ x: rand(), offset: rand(), speed: 0.75 + rand() * 0.5 });
      }
      const colWidth = Math.max(0.04, 1 / (n * 1.5));

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        const lx = (l.x - b.minX) / (b.w || 1);
        const ly = (l.y - b.minY) / (b.h || 1);
        let level = 0;
        for (const d of cols) {
          const dx = Math.abs(lx - d.x);
          if (dx > colWidth) continue;
          const head = ((t / period) * d.speed + d.offset) % 1;
          const below = ly - head;      // y grows downward in light space
          if (below < -0.02 || below > tail) continue;
          const along = below <= 0 ? 1 : 1 - below / tail;
          level = Math.max(level, along * (1 - dx / colWidth));
        }
        if (level > 0.004) put(i, p.color, level);
      }
      return true;
    }

    if (p.type === 'plasma') {
      // Overlapping sine fields: a slow, organic wash that never quite repeats
      // its shape. Hand-writing anything like it per light is hopeless.
      const b = targetBounds(layer, lights, mask);
      if (!b.n) return false;
      const period = this.fitPeriod(layer, p.plasmaMs, p.fit !== false);
      const k = Math.max(0.2, p.plasmaScale) * Math.PI;
      const ph = (t / period) * Math.PI * 2;
      const ca = hexToRgb(p.color);
      const cb = hexToRgb(p.color2 || p.color);

      for (let i = 0; i < lights.length; i++) {
        if (mask && !mask[i]) continue;
        const l = lights[i];
        const lx = (l.x - b.minX) / (b.w || 1);
        const ly = (l.y - b.minY) / (b.h || 1);
        const v = Math.sin(lx * k + ph)
                + Math.sin(ly * k * 1.3 - ph * 0.8)
                + Math.sin((lx + ly) * k * 0.7 + ph * 1.4);
        const u = (v / 3 + 1) / 2;                      // 0..1
        const hex = rgbToHex(ca.r + (cb.r - ca.r) * u,
                             ca.g + (cb.g - ca.g) * u,
                             ca.b + (cb.b - ca.b) * u);
        put(i, hex, 0.25 + u * 0.75);
      }
      return true;
    }

    if (p.type === 'chase') {
      const order = orderedTargets(layer, lights, mask);
      const n = order.length;
      if (!n) return false;
      // fit = exactly one pass along the lights over the clip
      const stepMs = p.fit !== false && layer.durationMs > 0
        ? Math.max(1, layer.durationMs / n)
        : Math.max(1, p.stepMs);
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
