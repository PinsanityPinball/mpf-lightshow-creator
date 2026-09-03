// The playfield view: draws the frame, the lights, the motion path and the
// selection handles, and turns mouse gestures into keyframe edits.

import { shapeExtent } from './shapes.js';
import { layerStateAtTime, stateAt, invalidateKeys, effectiveParams } from './project.js';
import { drawLights, colorsToHex } from './render.js';

const D2R = Math.PI / 180;
const HANDLE = 6;

export class Stage {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cw = 0;
    this.ch = 0;
    this.drag = null;
    this.hoverLight = -1;
    this.onionCanvas = document.createElement('canvas');

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag) { this.hoverLight = -1; this.app.setHoverInfo(''); }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------ geometry

  fit() {
    const wrap = this.canvas.parentElement;
    const availW = wrap.clientWidth - 24;
    const availH = wrap.clientHeight - 24;
    const aspect = this.app.project.aspect || 0.5;
    let w = availH * aspect;
    let h = availH;
    if (w > availW) { w = availW; h = availW / aspect; }
    w = Math.max(80, Math.floor(w));
    h = Math.max(160, Math.floor(h));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = w; this.ch = h;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  pointer(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Current on-screen state of a layer, or null if it is not showing. */
  liveState(layer) {
    return layerStateAtTime(layer, this.app.timeMs);
  }

  /** Convert a screen point into a layer's local unit space. */
  toLocal(st, px, py) {
    const cx = st.x * this.cw;
    const cy = st.y * this.ch;
    const a = -st.rot * D2R;
    const dx = px - cx;
    const dy = py - cy;
    const rx = dx * Math.cos(a) - dy * Math.sin(a);
    const ry = dx * Math.sin(a) + dy * Math.cos(a);
    const sx = Math.max(0.0001, Math.abs(st.sx) * this.cw);
    const sy = Math.max(0.0001, Math.abs(st.sy) * this.cw);
    return { x: rx / sx, y: ry / sy, px: rx, py: ry };
  }

  /** Screen position of a point given in the layer's local unit space. */
  toScreen(st, lx, ly) {
    const a = st.rot * D2R;
    const sx = Math.abs(st.sx) * this.cw;
    const sy = Math.abs(st.sy) * this.cw;
    const ox = lx * sx;
    const oy = ly * sy;
    return {
      x: st.x * this.cw + ox * Math.cos(a) - oy * Math.sin(a),
      y: st.y * this.ch + ox * Math.sin(a) + oy * Math.cos(a),
    };
  }

  handlePoints(layer, st) {
    const ext = shapeExtent(layer.shapeId, effectiveParams(layer, st));
    return {
      ext,
      scale: this.toScreen(st, ext, ext),
      rotate: this.toScreen(st, 0, -(ext + 0.35)),
      centre: this.toScreen(st, 0, 0),
    };
  }

  // ------------------------------------------------------------ hit tests

  hitsLayer(layer, px, py) {
    if (!layer || !layer.enabled || layer.kind !== 'shape') return false;
    const st = this.liveState(layer);
    if (!st) return false;
    const ext = shapeExtent(layer.shapeId, effectiveParams(layer, st));
    const l = this.toLocal(st, px, py);
    const pad = 6 / Math.max(1, Math.abs(st.sx) * this.cw);
    return Math.abs(l.x) <= ext + pad && Math.abs(l.y) <= ext + pad;
  }

  hitLayer(px, py) {
    // A selected layer under the cursor always wins, so picking a layer by name
    // and then dragging it does not silently grab whatever is drawn on top.
    const selected = this.app.selectedLayer();
    if (this.hitsLayer(selected, px, py)) return selected;

    const layers = this.app.project.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (this.hitsLayer(layers[i], px, py)) return layers[i];
    }
    return null;
  }

  nearestLight(px, py) {
    const lights = this.app.lights;
    let best = -1, bestD = 14 * 14;
    for (let i = 0; i < lights.length; i++) {
      const dx = lights[i].x * this.cw - px;
      const dy = lights[i].y * this.ch - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ------------------------------------------------------------ input

  onDown(e) {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this.pointer(e);
    const app = this.app;
    const layer = app.selectedLayer();

    if (layer && layer.kind === 'shape') {
      const st = this.liveState(layer);
      if (st) {
        const h = this.handlePoints(layer, st);
        if (dist(x, y, h.rotate.x, h.rotate.y) <= HANDLE + 4) {
          app.pushUndo('rotate');
          this.drag = { mode: 'rotate', layer, startRot: st.rot,
            startAngle: Math.atan2(y - h.centre.y, x - h.centre.x) / D2R };
          return;
        }
        if (dist(x, y, h.scale.x, h.scale.y) <= HANDLE + 4) {
          app.pushUndo('scale');
          this.drag = { mode: 'scale', layer, ext: h.ext };
          return;
        }
      }
    }

    const hit = this.hitLayer(x, y);
    if (hit) {
      if (!layer || hit.id !== layer.id) app.selectLayer(hit.id);
      const st = this.liveState(hit);
      // pushUndo first: with auto-key on, targetKey() inserts a keyframe, and a
      // snapshot taken after that already contains it, so undo could not remove it
      app.pushUndo('move');
      const key = app.targetKey(hit);
      // Dragging a shape should move the shape. With auto-key off and the
      // playhead between keyframes there is no single keyframe the drag
      // obviously belongs to, so it moves the whole layer and the shape follows
      // the pointer exactly. Parked on a keyframe, or with auto-key on, the
      // drag edits that one keyframe as before. Shift always moves everything.
      const onKey = app.keyAtPlayhead(hit) !== null;
      const moveAll = e.shiftKey || (!app.autoKey && !onKey);
      this.drag = {
        mode: 'move',
        layer: hit,
        all: moveAll,
        grabX: x / this.cw - (st ? st.x : 0.5),
        grabY: y / this.ch - (st ? st.y : 0.5),
        baseKeys: hit.keys.map((k) => ({ x: k.x, y: k.y })),
        baseX: key ? key.x : 0.5,
        baseY: key ? key.y : 0.5,
      };
      return;
    }

    // empty space: scrub-select the nearest light for reference, keep selection
    const li = this.nearestLight(x, y);
    if (li >= 0) app.toggleLightPin(li, e.ctrlKey || e.metaKey);
    else app.selectLayer(null);
    app.requestDraw();
  }

  onMove(e) {
    const { x, y } = this.pointer(e);
    const app = this.app;

    if (!this.drag) {
      const li = this.nearestLight(x, y);
      if (li !== this.hoverLight) {
        this.hoverLight = li;
        if (li >= 0 && app.colors) {
          app.setHoverInfo(`${app.lights[li].name}  ${colorsToHex(app.colors, li).toUpperCase()}`);
        } else {
          app.setHoverInfo('');
        }
      }
      const layer = app.selectedLayer();
      let cursor = 'crosshair';
      if (layer && layer.kind === 'shape') {
        const st = this.liveState(layer);
        if (st) {
          const h = this.handlePoints(layer, st);
          if (dist(x, y, h.rotate.x, h.rotate.y) <= HANDLE + 4) cursor = 'grab';
          else if (dist(x, y, h.scale.x, h.scale.y) <= HANDLE + 4) cursor = 'nwse-resize';
          else if (this.hitLayer(x, y)) cursor = 'move';
        }
      } else if (this.hitLayer(x, y)) cursor = 'move';
      this.canvas.style.cursor = cursor;
      return;
    }

    const d = this.drag;
    const layer = d.layer;

    if (d.mode === 'move') {
      const nx = clamp01(x / this.cw - d.grabX);
      const ny = clamp01(y / this.ch - d.grabY);
      if (d.all) {
        const dx = nx - d.baseX;
        const dy = ny - d.baseY;
        layer.keys.forEach((k, i) => {
          k.x = clamp01(d.baseKeys[i].x + dx);
          k.y = clamp01(d.baseKeys[i].y + dy);
        });
      } else {
        const key = app.targetKey(layer);
        if (key) { key.x = nx; key.y = ny; }
      }
    } else if (d.mode === 'rotate') {
      const st = this.liveState(layer) || stateAt(layer, 0);
      const c = this.toScreen(st, 0, 0);
      const ang = Math.atan2(y - c.y, x - c.x) / D2R;
      let rot = d.startRot + (ang - d.startAngle);
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      const key = app.targetKey(layer);
      if (key) key.rot = Math.round(rot * 10) / 10;
    } else if (d.mode === 'scale') {
      const st = this.liveState(layer) || stateAt(layer, 0);
      // px/py are the rotated offsets in screen pixels, before the size divide
      const l = this.toLocal(st, x, y);
      let sx = Math.abs(l.px) / (d.ext * this.cw);
      let sy = Math.abs(l.py) / (d.ext * this.cw);
      if (e.shiftKey) { const m = Math.max(sx, sy); sx = m; sy = m; }
      const key = app.targetKey(layer);
      if (key) {
        key.sx = Math.max(0.005, Math.round(sx * 1000) / 1000);
        key.sy = Math.max(0.005, Math.round(sy * 1000) / 1000);
      }
    }

    invalidateKeys(layer);
    app.onProjectEdit({ light: true });
  }

  onUp(e) {
    if (!this.drag) return;
    this.drag = null;
    this.app.onProjectEdit({});
    this.app.refreshInspector();
  }

  // ------------------------------------------------------------ drawing

  draw(colors) {
    const ctx = this.ctx;
    const app = this.app;
    const { cw, ch } = this;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    const showShapes = app.view !== 'lights';
    const showLights = app.view !== 'shapes';

    // Tracing guide underneath everything. Display only - it never reaches the
    // sampler, so it cannot affect exported colours.
    const bg = app.backgroundImage;
    if (bg && bg.complete && bg.naturalWidth && app.project.background
        && app.project.background.visible !== false) {
      ctx.save();
      ctx.globalAlpha = app.project.background.opacity == null ? 0.5 : app.project.background.opacity;
      ctx.drawImage(bg, 0, 0, cw, ch);
      ctx.restore();
    }

    if (showShapes) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = app.view === 'both' ? 0.85 : 1;
      ctx.drawImage(app.renderer.canvas, 0, 0, cw, ch);
      ctx.restore();
    }

    if (app.onion) this.drawOnion();
    if (app.showPath) this.drawPaths();

    if (showLights) {
      drawLights(ctx, app.lights, colors, {
        w: cw, h: ch,
        sizeScale: app.lightSize,
        showOff: app.showOff,
        glow: app.glow,
        selected: app.pinnedLights,
        // when the selected layer targets tags, ring the lights it can reach
        dimmed: app.targetHighlight(),
      });
    }

    this.drawHandles();
    this.drawFrame();
  }

  drawFrame() {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, this.cw - 1, this.ch - 1);
  }

  drawOnion() {
    const app = this.app;
    const layer = app.selectedLayer();
    if (!layer || layer.keys.length < 2) return;
    const r = app.renderer;
    const c = this.onionCanvas;
    if (c.width !== r.w || c.height !== r.h) { c.width = r.w; c.height = r.h; }
    const octx = c.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, r.w, r.h);
    for (const k of layer.keys) {
      r.drawLayer(layer, k, { ctx: octx, alphaScale: 0.45 });
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(c, 0, 0, this.cw, this.ch);
    ctx.restore();
  }

  drawPaths() {
    const app = this.app;
    const layer = app.selectedLayer();
    if (!layer || layer.kind !== 'shape') return;
    const ctx = this.ctx;
    // indexed as stored, so the highlighted diamond matches selectedKeyIndex
    const keys = layer.keys;
    if (keys.length < 1) return;

    // sampled path so easing is visible
    ctx.save();
    ctx.strokeStyle = 'rgba(79,195,247,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const steps = 96;
    for (let i = 0; i <= steps; i++) {
      const st = stateAt(layer, i / steps);
      const x = st.x * this.cw, y = st.y * this.ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    keys.forEach((k, i) => {
      const x = k.x * this.cw, y = k.y * this.ch;
      const sel = i === app.selectedKeyIndex;
      ctx.beginPath();
      ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
      ctx.closePath();
      ctx.fillStyle = sel ? '#ffb74d' : '#4fc3f7';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    ctx.restore();
  }

  drawHandles() {
    const app = this.app;
    const layer = app.selectedLayer();
    if (!layer || layer.kind !== 'shape') return;
    const st = this.liveState(layer) || stateAt(layer, 0);
    const h = this.handlePoints(layer, st);
    const ctx = this.ctx;
    const ext = h.ext;

    ctx.save();
    ctx.translate(st.x * this.cw, st.y * this.ch);
    ctx.rotate(st.rot * D2R);
    ctx.strokeStyle = 'rgba(79,195,247,0.75)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    const w = ext * Math.abs(st.sx) * this.cw * 2;
    const hh = ext * Math.abs(st.sy) * this.cw * 2;
    ctx.strokeRect(-w / 2, -hh / 2, w, hh);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, -hh / 2);
    ctx.lineTo(0, -hh / 2 - 0.35 * Math.abs(st.sy) * this.cw);
    ctx.stroke();
    ctx.restore();

    dot(ctx, h.scale.x, h.scale.y, '#4fc3f7');
    dot(ctx, h.rotate.x, h.rotate.y, '#ffb74d');
    dot(ctx, h.centre.x, h.centre.y, '#ffffff', 3);
  }
}

function dot(ctx, x, y, color, r = HANDLE) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
