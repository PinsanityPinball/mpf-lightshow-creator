// Canvas timeline: a clip per layer, keyframe diamonds on each clip, and a
// scrubbable playhead. Replaces the original tool's "press P and hope".

import {
  projectDuration, invalidateKeys, makeKey, stateAt, layerFireTimes, setLayerStart,
} from './project.js';
import { status } from './ui.js';

const ROW_H = 30;
const RULER_H = 26;
const PAD_L = 8;
// Grab width for the clip's start/end handles. The first and last keyframes
// sit exactly on those edges, so this band is tested before keyframes are -
// otherwise the key always wins and the clip can never be resized.
const EDGE = 8;

export class Timeline {
  constructor(app, canvas, headsEl) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.heads = headsEl;
    this.w = 0;
    this.h = 0;
    this.scrollMs = 0;
    this.scrollY = 0;
    // non-zero only while a drag is in flight, to stop the scale chasing the
    // very value being dragged
    this.pinnedDur = 0;
    this.drag = null;
    this.hover = null;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    headsEl.addEventListener('scroll', () => {
      this.scrollY = headsEl.scrollTop;
      this.draw();
    });
  }

  fit() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(100, Math.floor(rect.width));
    this.h = Math.max(60, Math.floor(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ------------------------------------------------------------ mapping

  /**
   * Pixels per millisecond.
   *
   * The scale is derived from the show's length, and the show's length is the
   * end of its longest layer - so dragging that layer's end used to move the
   * ruler under the pointer. Longer clip, longer show, smaller scale, and the
   * same pointer position now meant an earlier time, so the drag fought back
   * and settled somewhere short of where it was let go. Pinning the length for
   * the duration of a gesture breaks the loop. Zoom is deliberately left live,
   * so ctrl+wheel still works mid-drag.
   */
  pxPerMs() {
    const dur = Math.max(1, this.pinnedDur || projectDuration(this.app.project));
    return ((this.w - PAD_L * 2) / dur) * this.app.zoom;
  }

  /** Hold the scale still while a gesture is in flight. */
  pinScale() {
    this.pinnedDur = Math.max(1, projectDuration(this.app.project));
  }

  unpinScale() {
    this.pinnedDur = 0;
  }

  msToX(ms) { return PAD_L + (ms - this.scrollMs) * this.pxPerMs(); }
  xToMs(x) { return (x - PAD_L) / this.pxPerMs() + this.scrollMs; }

  rowY(i) { return RULER_H + i * ROW_H - this.scrollY; }

  rowAt(y) {
    const i = Math.floor((y + this.scrollY - RULER_H) / ROW_H);
    return (i >= 0 && i < this.app.project.layers.length) ? i : -1;
  }

  pointer(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ------------------------------------------------------------ hit tests

  keyAt(layer, rowTop, x, y) {
    if (Math.abs(y - (rowTop + ROW_H / 2)) > 10) return -1;
    const dur = Math.max(1, layer.durationMs);
    for (let i = 0; i < layer.keys.length; i++) {
      const kx = this.msToX(layer.startMs + layer.keys[i].t * dur);
      if (Math.abs(x - kx) <= 6) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------ input

  /** Right edge of the clip as drawn: the end of its first firing. */
  clipEndMs(layer) {
    return layer.startMs
      + Math.max(1, layer.durationMs) * Math.max(1, layer.repeat || 1);
  }

  onDown(e) {
    const { x, y } = this.pointer(e);
    const app = this.app;
    this.canvas.setPointerCapture(e.pointerId);

    if (y < RULER_H) {
      this.drag = { mode: 'scrub' };
      app.setTime(this.xToMs(x));
      return;
    }

    const row = this.rowAt(y);
    if (row < 0) { app.selectLayer(null); app.requestDraw(); return; }

    const layer = app.project.layers[row];
    // Grabbing a clip that is already part of a multi-selection must not reduce
    // the selection to it - the whole point is to drag the group. Reducing is
    // what a plain *click* means, so that happens on mouse up instead, and only
    // if nothing was dragged.
    const mods = e.ctrlKey || e.metaKey || e.shiftKey;
    const inGroup = app.isSelected(layer.id) && app.selectedIds().length > 1;
    if (mods || !inGroup) app.selectLayer(layer.id);
    else app.makePrimary(layer.id);
    const rowTop = this.rowY(row);

    const x0 = this.msToX(layer.startMs);
    const x1 = this.msToX(this.clipEndMs(layer));
    const onEdge = Math.abs(x - x0) <= EDGE || Math.abs(x - x1) <= EDGE;

    // Keyframes come first everywhere except the two edges. The end keys live
    // exactly on them, and resizing the clip is by far the more common thing to
    // want there - the end keys can still be moved from the Keyframe tab.
    const ki = onEdge ? -1 : this.keyAt(layer, rowTop, x, y);
    if (ki >= 0) {
      app.selectKey(ki);
      app.pushUndo('move keyframe');
      this.pinScale();
      this.drag = { mode: 'key', layer, index: ki };
      app.refreshInspector();
      app.requestDraw();
      return;
    }

    if (x >= x0 - EDGE && x <= x1 + EDGE) {
      // Ctrl adds to the selection, Shift takes the range - the same as the
      // track heads, so it does not matter which half of the row you click.
      if (e.ctrlKey || e.metaKey) { app.toggleLayerSelection(layer.id); return; }
      if (e.shiftKey && app.selectedLayerId && app.selectedLayerId !== layer.id) {
        app.selectLayerRange(layer.id);
        return;
      }
      app.pushUndo('move clip');
      this.pinScale();
      let mode = 'clip';
      if (Math.abs(x - x0) <= EDGE) mode = 'clipL';
      else if (Math.abs(x - x1) <= EDGE) mode = 'clipR';
      // keep the panel pointing at the end being dragged
      if (mode === 'clipL') app.selectKey(0);
      else if (mode === 'clipR') app.selectKey(layer.keys.length - 1);
      // Dragging one clip of a multi-selection drags all of them, by the same
      // amount - so the shape of the group survives. Only when the clip grabbed
      // is part of that selection; grabbing an unselected clip means you meant
      // that one.
      const group = app.isSelected(layer.id)
        ? app.selectedIds().map((id) => app.project.layers.find((l) => l.id === id))
          .filter(Boolean)
        : [layer];
      this.drag = {
        mode, layer,
        grabMs: this.xToMs(x) - layer.startMs,
        startMs: layer.startMs,
        durationMs: layer.durationMs,
        group,
        was: group.map((l) => ({ startMs: l.startMs, durationMs: l.durationMs })),
        // a click that never became a drag still means "just this one"
        mayReduce: !mods && inGroup,
        moved: false,
      };
      app.refreshInspector();
      return;
    }

    // empty part of the row: scrub
    this.drag = { mode: 'scrub' };
    app.setTime(this.xToMs(x));
  }

  onMove(e) {
    const { x, y } = this.pointer(e);
    const app = this.app;
    const d = this.drag;

    if (!d) {
      const row = this.rowAt(y);
      let cursor = y < RULER_H ? 'ew-resize' : 'default';
      if (row >= 0) {
        const layer = app.project.layers[row];
        const rowTop = this.rowY(row);
        const x0 = this.msToX(layer.startMs);
        const x1 = this.msToX(this.clipEndMs(layer));
        if (Math.abs(x - x0) <= EDGE || Math.abs(x - x1) <= EDGE) cursor = 'ew-resize';
        else if (this.keyAt(layer, rowTop, x, y) >= 0) cursor = 'grab';
        else if (x > x0 && x < x1) cursor = 'move';
      }
      this.canvas.style.cursor = cursor;
      return;
    }

    if (d.mode === 'scrub') {
      app.setTime(this.xToMs(x));
      return;
    }

    const layer = d.layer;
    const snap = app.snapMs();

    if (d.mode === 'key') {
      const dur = Math.max(1, layer.durationMs);
      let ms = this.xToMs(x) - layer.startMs;
      if (!e.altKey) ms = Math.round(ms / snap) * snap;
      const keys = layer.keys;
      const t = Math.max(0, Math.min(1, ms / dur));
      keys[d.index].t = t;
      invalidateKeys(layer);
    } else if (d.mode === 'clip') {
      let ms = this.xToMs(x) - d.grabMs;
      if (!e.altKey) ms = Math.round(ms / snap) * snap;
      // carries the layer's extra firings with it
      setLayerStart(layer, ms);
      this.spread(d, 'startMs', layer.startMs - d.startMs, snap);
    } else if (d.mode === 'clipL') {
      let ms = this.xToMs(x);
      if (!e.altKey) ms = Math.round(ms / snap) * snap;
      ms = Math.max(0, Math.min(ms, d.startMs + d.durationMs - snap));
      const delta = ms - d.startMs;
      setLayerStart(layer, ms);
      layer.durationMs = Math.max(snap, Math.round(d.durationMs - delta));
      this.spread(d, 'both', delta, snap);
    } else if (d.mode === 'clipR') {
      let ms = this.xToMs(x);
      if (!e.altKey) ms = Math.round(ms / snap) * snap;
      const reps = Math.max(1, layer.repeat || 1);
      layer.durationMs = Math.max(snap, Math.round((ms - layer.startMs) / reps));
      this.spread(d, 'durationMs', layer.durationMs - d.durationMs, snap);
    }

    d.moved = true;
    app.onProjectEdit({ light: true });
  }


  /**
   * Apply the primary clip's change to the rest of the selection.
   *
   * By the same delta rather than to the same value: dragging three clips'
   * ends should keep them three different lengths, not collapse them onto one.
   * Every layer is measured from where it was when the drag started, so the
   * result does not drift as the pointer moves back and forth.
   */
  spread(d, what, delta, snap) {
    if (!d.group || d.group.length < 2 || !delta) return;
    for (let i = 0; i < d.group.length; i++) {
      const l = d.group[i];
      if (l === d.layer) continue;
      const was = d.was[i];
      if (what === 'startMs' || what === 'both') {
        setLayerStart(l, Math.max(0, was.startMs + delta));
      }
      if (what === 'durationMs') {
        l.durationMs = Math.max(snap, Math.round(was.durationMs + delta));
      }
      if (what === 'both') {
        l.durationMs = Math.max(snap, Math.round(was.durationMs - delta));
      }
      invalidateKeys(l);
    }
  }

  onUp() {
    if (!this.drag) return;
    if (this.drag.mayReduce && !this.drag.moved) {
      this.app.selectLayer(this.drag.layer.id);
    }
    const wasKey = this.drag.mode === 'key';
    this.drag = null;
    this.unpinScale();
    this.app.onProjectEdit({});
    if (wasKey) this.app.refreshInspector();
  }

  onDblClick(e) {
    const { x, y } = this.pointer(e);
    const row = this.rowAt(y);
    if (row < 0) return;
    const app = this.app;
    const layer = app.project.layers[row];
    const rowTop = this.rowY(row);
    const ki = this.keyAt(layer, rowTop, x, y);
    if (ki >= 0) {
      // Double-clicking the last keyframe stretches the layer to the end of the
      // show. The keyframes are stored as fractions of the clip, so they scale
      // with it and the composition is kept - only the clock changes.
      const last = layer.keys.reduce((m, k) => Math.max(m, k.t), 0);
      if (layer.keys[ki].t === last) this.fillShow(layer);
      return;
    }
    const dur = Math.max(1, layer.durationMs);
    const t = Math.max(0, Math.min(1, (this.xToMs(x) - layer.startMs) / dur));
    app.pushUndo('add keyframe');
    const st = stateAt(layer, t);
    layer.keys.push(makeKey(t, st));
    layer.keys.sort((a, b) => a.t - b.t);
    invalidateKeys(layer);
    app.selectLayer(layer.id);
    app.selectKey(layer.keys.findIndex((k) => k.t === t));
    app.onProjectEdit({});
    app.refreshInspector();
  }

  /** Stretch a layer so it runs to the end of the show. */
  fillShow(layer) {
    const app = this.app;
    const showEnd = Math.round(projectDuration(app.project));
    const reps = Math.max(1, layer.repeat || 1);
    const want = Math.round((showEnd - layer.startMs) / reps);
    if (want < 16) {
      status('That layer starts too close to the end of the show to stretch.', 'err');
      return;
    }
    if (want === layer.durationMs) {
      // On "follow the layers" the longest layer *is* the show, so asking it to
      // fill the show is asking for what it already does. Saying so beats a
      // double-click that looks like it did nothing.
      status(app.project.durationMs > 0
        ? 'That layer already runs to the end of the show.'
        : 'That layer already ends the show. Give the show a fixed length on the '
          + 'Show tab to stretch layers to it.', 'ok');
      return;
    }
    app.pushUndo('fill the show');
    const was = layer.durationMs;
    layer.durationMs = Math.max(16, want);
    invalidateKeys(layer);
    app.onProjectEdit({});
    app.refreshInspector();
    status(`${layer.name}: ${was} ms -> ${layer.durationMs} ms, `
      + `ending at ${showEnd} ms with the show.`, 'ok');
  }

  onWheel(e) {
    e.preventDefault();
    const app = this.app;
    // Plain wheel zooms, the same as over the playfield. Row scrolling moves to
    // Ctrl, which it has to share with nothing else - the track heads beside the
    // timeline still scroll on their own too.
    if (e.ctrlKey) {
      const max = Math.max(0, this.app.project.layers.length * ROW_H - (this.h - RULER_H));
      this.scrollY = Math.max(0, Math.min(max, this.scrollY + e.deltaY));
      this.heads.scrollTop = this.scrollY;
      this.draw();
    } else if (e.shiftKey) {
      this.scrollMs = Math.max(0, this.scrollMs + e.deltaY / this.pxPerMs());
      this.draw();
    } else {
      const before = this.xToMs(this.pointer(e).x);
      app.setZoom(app.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      const after = this.xToMs(this.pointer(e).x);
      this.scrollMs = Math.max(0, this.scrollMs + (before - after));
      this.draw();
    }
  }

  // ------------------------------------------------------------ drawing

  draw() {
    const ctx = this.ctx;
    const app = this.app;
    const { w, h } = this;
    if (!w) return;

    ctx.fillStyle = '#0f131a';
    ctx.fillRect(0, 0, w, h);

    const dur = projectDuration(app.project);
    this.drawRuler(dur);

    app.project.layers.forEach((layer, i) => {
      const y = this.rowY(i);
      if (y + ROW_H < RULER_H || y > h) return;
      this.drawRow(layer, i, y);
    });

    // playhead
    const px = this.msToX(app.timeMs);
    ctx.save();
    ctx.strokeStyle = '#ff6d5a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.fillStyle = '#ff6d5a';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawRuler(dur) {
    const ctx = this.ctx;
    ctx.fillStyle = '#161c25';
    ctx.fillRect(0, 0, this.w, RULER_H);
    ctx.strokeStyle = '#2a3240';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(this.w, RULER_H - 0.5);
    ctx.stroke();

    const ppm = this.pxPerMs();
    const targetPx = 70;
    const rawStep = targetPx / ppm;
    const step = niceStep(rawStep);
    const first = Math.floor(this.scrollMs / step) * step;
    const last = this.xToMs(this.w);

    ctx.font = '10px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (let ms = first; ms <= last; ms += step) {
      const x = this.msToX(ms);
      if (x < -40 || x > this.w + 40) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H - 7);
      ctx.lineTo(Math.round(x) + 0.5, RULER_H);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H);
      ctx.lineTo(Math.round(x) + 0.5, this.h);
      ctx.stroke();
      ctx.fillStyle = '#7c889a';
      ctx.fillText(ms >= 1000 ? (ms / 1000).toFixed(step >= 1000 ? 0 : 1) + 's' : ms + 'ms', x + 3, 9);
    }

    // end-of-show marker
    const ex = this.msToX(dur);
    ctx.strokeStyle = 'rgba(255,183,77,0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ex, 0); ctx.lineTo(ex, this.h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawRow(layer, index, y) {
    const ctx = this.ctx;
    const app = this.app;
    const selected = app.isSelected(layer.id);

    if (index % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.015)';
      ctx.fillRect(0, y, this.w, ROW_H);
    }
    if (selected) {
      ctx.fillStyle = 'rgba(79,195,247,0.07)';
      ctx.fillRect(0, y, this.w, ROW_H);
    }

    const reps = Math.max(1, layer.repeat || 1);
    const dur = Math.max(1, layer.durationMs);

    // An instanced layer fires more than once. Each extra firing is drawn as a
    // faint bar so the pattern of them is visible; the first firing is drawn
    // normally below, since it is the one the clip handles belong to.
    const fires = layerFireTimes(layer);
    if (fires.length > 1) {
      ctx.save();
      ctx.globalAlpha = layer.enabled ? 0.45 : 0.18;
      ctx.fillStyle = layer.kind === 'pattern' && layer.pattern ? layer.pattern.color
        : (layer.keys.length ? layer.keys[0].color : '#4fc3f7');
      for (let i = 1; i < fires.length; i++) {
        const ix = this.msToX(fires[i]);
        const iw = Math.max(2, this.msToX(fires[i] + dur * reps) - ix);
        if (ix > this.w || ix + iw < 0) continue;
        ctx.fillRect(ix, y + 8, iw, ROW_H - 16);
      }
      ctx.restore();
    }

    const x0 = this.msToX(layer.startMs);
    const x1 = this.msToX(layer.startMs + dur * reps);
    const bw = Math.max(3, x1 - x0);
    const by = y + 5;
    const bh = ROW_H - 10;

    const tint = layer.kind === 'pattern' && layer.pattern ? layer.pattern.color
      : (layer.keys.length ? layer.keys[0].color : '#4fc3f7');
    ctx.save();
    ctx.globalAlpha = layer.enabled ? 1 : 0.35;

    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, shade(tint, 0.55));
    grad.addColorStop(1, shade(layer.kind === 'pattern' ? tint
      : (layer.keys.length ? layer.keys[layer.keys.length - 1].color : tint), 0.35));
    ctx.fillStyle = grad;
    roundRect(ctx, x0, by, bw, bh, 4);
    ctx.fill();

    ctx.strokeStyle = selected ? '#8fd8ff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = selected ? 1.5 : 1;
    roundRect(ctx, x0, by, bw, bh, 4);
    ctx.stroke();

    // repeat dividers
    if (reps > 1) {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      for (let r = 1; r < reps; r++) {
        const rx = this.msToX(layer.startMs + dur * r);
        ctx.beginPath();
        ctx.moveTo(rx, by); ctx.lineTo(rx, by + bh);
        ctx.stroke();
      }
    }

    // hold indicators
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    if (layer.holdBefore && x0 > 0) {
      ctx.beginPath();
      ctx.moveTo(0, y + ROW_H / 2); ctx.lineTo(x0, y + ROW_H / 2);
      ctx.stroke();
    }
    if (layer.holdAfter) {
      ctx.beginPath();
      ctx.moveTo(x1, y + ROW_H / 2); ctx.lineTo(this.w, y + ROW_H / 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // label
    if (bw > 44) {
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 3, by, bw - 6, bh);
      ctx.clip();
      ctx.fillText(layer.name, x0 + 7, y + ROW_H / 2);
      ctx.restore();
    }
    // Resize grips. The end keyframes sit on these edges, so without a visible
    // handle there is nothing to say the clip can be dragged shorter or longer.
    if (selected && bw > 16) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (const gx of [x0 + 2.5, x1 - 4.5]) {
        ctx.fillRect(gx, by + 3, 2, bh - 6);
      }
    }
    ctx.restore();

    // keyframes
    const cy = y + ROW_H / 2;
    layer.keys.forEach((k, i) => {
      const kx = this.msToX(layer.startMs + k.t * dur);
      if (kx < -10 || kx > this.w + 10) return;
      const sel = selected && i === app.selectedKeyIndex;
      ctx.beginPath();
      ctx.moveTo(kx, cy - 6); ctx.lineTo(kx + 6, cy);
      ctx.lineTo(kx, cy + 6); ctx.lineTo(kx - 6, cy);
      ctx.closePath();
      ctx.fillStyle = sel ? '#ffb74d' : '#e9f4ff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (k.ease === 'hold') {
        ctx.fillStyle = '#0f131a';
        ctx.fillRect(kx - 1.5, cy - 2, 3, 4);
      }
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex, k) {
  const h = String(hex || '#4fc3f7').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = Math.round((((n >> 16) & 255) * k) + 26);
  const g = Math.round((((n >> 8) & 255) * k) + 30);
  const b = Math.round(((n & 255) * k) + 38);
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}

function niceStep(raw) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
  for (const s of steps) if (s >= raw) return s;
  return 120000;
}
