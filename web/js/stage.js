// The playfield view: draws the frame, the lights, the motion path and the
// selection handles, and turns mouse gestures into keyframe edits.

import { shapeExtent } from './shapes.js';
import {
  layerStateAtTime, stateAt, invalidateKeys, effectiveParams, makeKey,
} from './project.js';
import { status } from './ui.js';
import { drawLights, colorsToHex } from './render.js';

const D2R = Math.PI / 180;
// A keyframe diamond is drawn 5px from centre to point; this is how close the
// pointer has to be to grab one, with a little room for a shaky hand.
const KEY_GRAB = 9;
// The path line is 1.25px wide and dashed, so it needs a wider catchment than
// it looks like it does.
const PATH_GRAB = 6;

/** Distance from a point to a line segment. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return dist(px, py, ax + dx * t, ay + dy * t);
}
const HANDLE = 6;

export class Stage {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cw = 0;
    this.ch = 0;
    // Zooming out shows the space around the playfield. Presets legitimately
    // put keyframes past the edge - a sweep starts at y 1.08 so it enters from
    // off-field - and at 1:1 those sit outside the canvas where they cannot be
    // clicked. 1 is the playfield filling the canvas exactly, so the default is
    // pixel-for-pixel what it always was.
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.drag = null;
    this.hoverLight = -1;
    this.onionCanvas = document.createElement('canvas');

    canvas.addEventListener('dblclick', (e) => {
      if (this.app.drawPath) { this.app.finishPathDraw(); return; }
      // Double-clicking a path adds a point to it, the same way double-clicking
      // a clip in the timeline adds a keyframe to that.
      const layer = this.app.selectedLayer();
      if (!layer || layer.kind !== 'shape') return;
      const { x, y } = this.pointer(e);
      this.insertOnPath(layer, x, y);
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
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
    // Undo the view transform, so every hit test downstream keeps working in
    // playfield pixels and none of them has to know about zoom.
    return {
      x: (e.clientX - r.left - this.panX) / this.zoom,
      y: (e.clientY - r.top - this.panY) / this.zoom,
    };
  }

  /** Wheel over the playfield zooms about the pointer. */
  onWheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    // the playfield point under the cursor, which must not move
    const ux = (cx - this.panX) / this.zoom;
    const uy = (cy - this.panY) / this.zoom;
    const next = Math.max(0.3, Math.min(4, this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    this.zoom = next;
    this.panX = cx - ux * next;
    this.panY = cy - uy * next;
    // Zooming back through 1:1 tidies itself up, but that only helps if you
    // happen to land there - hence the Recentre button, which always does.
    if (Math.abs(this.zoom - 1) < 0.02 && !this.panX && !this.panY) this.zoom = 1;
    this.draw();
  }

  /** Back to the playfield filling the canvas. */
  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.draw();
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
    // A layer with no shape draws nothing, so there is nothing there to click.
    // Without this it still had the bounding box of a default shape, and a
    // drawn path - which has no shape by design - answered clicks aimed at its
    // line with "you grabbed the shape".
    if (layer.shapeId === 'none') return false;
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
    // While drawing a path every click is a point on it. Nothing else on the
    // playfield does anything until the path is finished or thrown away, so
    // there is no chance of half-drawing one and wondering why the shape moved.
    if (this.app.drawPath && (e.button === 0 || e.button === 2)) {
      e.preventDefault();
      const p = this.pointer(e);
      const drawn = this.app.project.layers.find((l) => l.id === this.app.drawPath.id);
      // Right places the next point; left picks up one already placed. Without
      // the split, a click meant to nudge a point you had just put down added
      // another one on top of it.
      if (e.button === 0) {
        const ki = drawn ? this.hitKeyframe(drawn, p.x, p.y) : -1;
        if (ki >= 0) this.grabKeyframe(drawn, ki, p.x, p.y, false);
        return;                      // left on empty space does nothing while drawing
      }
      this.app.addPathPoint(offField(p.x / this.cw), offField(p.y / this.ch));
      return;
    }

    // Middle button pans the view. It is the one gesture that moves the camera
    // rather than the show, so it deliberately does not touch the project and
    // takes no undo step.
    if (e.button === 1) {
      e.preventDefault();
      // Start the gesture before asking for capture: capture is an optimisation
      // that keeps the drag alive outside the canvas, and if it throws the pan
      // should still work rather than the whole gesture being lost.
      this.drag = {
        mode: 'pan',
        fromX: e.clientX, fromY: e.clientY,
        panX: this.panX, panY: this.panY,
      };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    // Left moves the whole layer, right edits one keyframe. Which mouse button
    // you press is a clearer way to say which you meant than a mode checkbox
    // plus wherever the playhead happens to be sitting.
    if (e.button !== 0 && e.button !== 2) return;
    const wholeLayer = e.button === 0 && !this.app.autoKey;
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
          this.drag = {
            mode: 'rotate', layer, startRot: st.rot,
            all: wholeLayer,
            baseRot: layer.keys.map((k) => k.rot),
            startAngle: Math.atan2(y - h.centre.y, x - h.centre.x) / D2R,
          };
          return;
        }
        if (dist(x, y, h.scale.x, h.scale.y) <= HANDLE + 4) {
          app.pushUndo('scale');
          this.drag = {
            mode: 'scale', layer, ext: h.ext,
            all: wholeLayer,
            baseScale: layer.keys.map((k) => ({ sx: k.sx, sy: k.sy })),
            startSx: st.sx || 1, startSy: st.sy || 1,
          };
          return;
        }
      }
    }

    // Right-clicking a keyframe diamond means "move this one". It used to fall
    // straight through to keyForEdit, which works off the playhead - so unless
    // the playhead happened to be sitting on that keyframe it made a brand new
    // one where the playhead was, and the keyframe you clicked never moved.
    if (!wholeLayer && layer) {
      // Point at a keyframe and you move that keyframe. Always, wherever the
      // playhead is. This used to defer to the playhead when the keyframe sat
      // under the shape, because right-click was the only way to add one and
      // the two gestures fought - now adding is double-clicking the path, so
      // they no longer have to share.
      const ki = this.hitKeyframe(layer, x, y);
      if (ki >= 0) {
        // Move the playhead to the keyframe being edited, so what is on screen
        // is the thing being changed.
        this.grabKeyframe(layer, ki, x, y, true);
        return;
      }
    }

    // Left-dragging anywhere on the path - a keyframe or the line between two -
    // moves the whole layer. The path is often the only part of a layer near the
    // pointer, and having it be scenery you cannot grab made moving a layer mean
    // hunting for wherever the shape happened to be at the playhead.
    if (wholeLayer && layer && (this.hitKeyframe(layer, x, y) >= 0 || this.hitPath(layer, x, y))) {
      const st = this.liveState(layer);
      // With no live state - the playhead sitting outside the clip - measure
      // from the point grabbed rather than from the middle of the playfield,
      // which would throw the delta off by however far the layer is from centre.
      const bx = st ? st.x : x / this.cw;
      const by = st ? st.y : y / this.ch;
      app.pushUndo('move');
      this.drag = {
        mode: 'move', layer, all: true,
        grabX: x / this.cw - bx,
        grabY: y / this.ch - by,
        baseKeys: layer.keys.map((k) => ({ x: k.x, y: k.y })),
        baseX: bx, baseY: by,
      };
      return;
    }

    // Right-clicking the path itself, away from the shape, adds a point there.
    // Right-click already means "keyframe" everywhere else on the playfield, and
    // this is the one place where the click says which keyframe without anyone
    // having to look at the playhead.
    if (e.button === 2 && layer && !this.hitLayer(x, y)
        && this.hitPath(layer, x, y)) {
      if (this.insertOnPath(layer, x, y)) return;
    }

    const hit = this.hitLayer(x, y);
    if (hit) {
      if (!layer || hit.id !== layer.id) app.selectLayer(hit.id);
      const st = this.liveState(hit);

      // With the playhead off the clip there is no time for a keyframe to be
      // at, and keyForEdit used to fall back to whichever keyframe happened to
      // be selected - so a right-drag quietly moved a keyframe somewhere else
      // in the clip, at a time you were not looking at. Refusing and saying why
      // is better than an edit nobody asked for.
      if (!wholeLayer && app.layerPhase(hit) === null) {
        status('The playhead is not over this clip, so there is no point in it to '
          + 'put a keyframe. Move the playhead onto the clip first.', 'err');
        return;
      }

      // pushUndo first: a right-drag inserts a keyframe through targetKey, and a
      // snapshot taken after that already contains it, so undo could not remove it
      app.pushUndo('move');
      // Right button (or auto-key) edits the keyframe at the playhead, creating
      // one if there is not one there yet. Left moves the whole layer.
      const had = hit.keys.length;
      const key = wholeLayer ? null : app.keyForEdit(hit);
      // Whether this added one or picked up the one already there is the
      // difference people cannot see, and "why did it not add a keyframe?"
      // is exactly that question.
      if (!wholeLayer && key) {
        const ms = Math.round(hit.startMs + key.t * Math.max(1, hit.durationMs));
        status(hit.keys.length > had
          ? `Added a keyframe at ${ms} ms.`
          : `Moving the keyframe already at ${ms} ms.`, 'ok');
      }
      this.drag = {
        mode: 'move',
        layer: hit,
        all: wholeLayer,
        grabX: x / this.cw - (st ? st.x : 0.5),
        grabY: y / this.ch - (st ? st.y : 0.5),
        baseKeys: hit.keys.map((k) => ({ x: k.x, y: k.y })),
        // The whole-layer delta is measured from where the shape actually is,
        // not from a keyframe: with no key to read it fell back to 0.5, so the
        // delta came out wrong - and for a shape sitting at 0.3 dragged 0.2, it
        // came out as exactly zero and the layer did not move at all.
        baseX: key ? key.x : (st ? st.x : 0.5),
        baseY: key ? key.y : (st ? st.y : 0.5),
      };
      return;
    }

    // Right-clicking the playfield with no layer selected means "I want to make
    // something here", and the only thing that can be made by pointing at the
    // playfield is a path. The first click is its first point.
    if (e.button === 2 && !app.selectedLayer()) {
      app.startPathDraw();
      app.addPathPoint(offField(x / this.cw), offField(y / this.ch));
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
          else if (this.hitKeyframe(layer, x, y) >= 0) cursor = 'move';
          else if (this.hitPath(layer, x, y)) cursor = 'move';
        }
      } else if (this.hitLayer(x, y)) cursor = 'move';
      this.canvas.style.cursor = cursor;
      return;
    }

    const d = this.drag;
    if (d.mode === 'pan') {
      // Raw client pixels, not playfield units: the camera moves in screen
      // space, so dividing by zoom here would make panning slower as you zoom in.
      this.panX = d.panX + (e.clientX - d.fromX);
      this.panY = d.panY + (e.clientY - d.fromY);
      this.draw();
      return;
    }
    const layer = d.layer;

    if (d.mode === 'move') {
      // Not clamp01: keyframes off the edge are a real technique - a sweep
      // starts off-field so it enters from outside - and clamping snapped any
      // such keyframe back onto the playfield the moment it was touched.
      const nx = offField(x / this.cw - d.grabX);
      const ny = offField(y / this.ch - d.grabY);
      if (d.all) {
        const dx = nx - d.baseX;
        const dy = ny - d.baseY;
        layer.keys.forEach((k, i) => {
          k.x = offField(d.baseKeys[i].x + dx);
          k.y = offField(d.baseKeys[i].y + dy);
        });
      } else {
        // A drag that started on a diamond stays on that diamond. Frame snapping
        // can nudge the playhead just past keyAtPlayhead's half-frame tolerance,
        // and then targetKey would quietly start making a new keyframe mid-drag.
        const key = (d.keyIndex != null && layer.keys[d.keyIndex])
          ? layer.keys[d.keyIndex]
          : app.targetKey(layer);
        if (key) { key.x = nx; key.y = ny; }
      }
    } else if (d.mode === 'rotate') {
      const st = this.liveState(layer) || stateAt(layer, 0);
      const c = this.toScreen(st, 0, 0);
      const ang = Math.atan2(y - c.y, x - c.x) / D2R;
      let delta = ang - d.startAngle;
      if (e.shiftKey) {
        delta = Math.round((d.startRot + delta) / 15) * 15 - d.startRot;
      }
      if (d.all) {
        layer.keys.forEach((k, i) => { k.rot = Math.round((d.baseRot[i] + delta) * 10) / 10; });
      } else {
        const key = app.keyForEdit(layer);
        if (key) key.rot = Math.round((d.startRot + delta) * 10) / 10;
      }
    } else if (d.mode === 'scale') {
      const st = this.liveState(layer) || stateAt(layer, 0);
      // px/py are the rotated offsets in screen pixels, before the size divide
      const l = this.toLocal(st, x, y);
      let sx = Math.abs(l.px) / (d.ext * this.cw);
      let sy = Math.abs(l.py) / (d.ext * this.cw);
      if (e.shiftKey) { const m = Math.max(sx, sy); sx = m; sy = m; }
      const clean = (v) => Math.max(0.005, Math.round(v * 1000) / 1000);
      if (d.all) {
        // scale every keyframe by the same factor, so a layer that grows keeps
        // growing rather than being flattened to one size
        const fx = sx / Math.max(0.005, d.startSx);
        const fy = sy / Math.max(0.005, d.startSy);
        layer.keys.forEach((k, i) => {
          k.sx = clean(d.baseScale[i].sx * fx);
          k.sy = clean(d.baseScale[i].sy * fy);
        });
      } else {
        const key = app.keyForEdit(layer);
        if (key) { key.sx = clean(sx); key.sy = clean(sy); }
      }
    }

    invalidateKeys(layer);
    app.onProjectEdit({ light: true });
  }

  onUp(e) {
    if (!this.drag) return;
    if (this.drag.mode === 'pan') {
      this.drag = null;
      this.canvas.style.cursor = 'crosshair';
      return;                      // nothing changed in the project, so no redraw churn
    }
    this.drag = null;
    this.app.onProjectEdit({});
    this.app.refreshInspector();
  }

  // ------------------------------------------------------------ drawing

  draw(colors) {
    const ctx = this.ctx;
    const app = this.app;
    const { cw, ch } = this;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // Clear and fill the whole canvas untransformed, so the area outside the
    // playfield reads as surround rather than as playable space.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = this.zoom === 1 ? '#000' : '#05070a';
    ctx.fillRect(0, 0, cw, ch);

    // Everything from here down is drawn in playfield pixels, exactly as it was
    // before zoom existed - the transform does the work instead.
    ctx.setTransform(dpr * this.zoom, 0, 0, dpr * this.zoom,
      dpr * this.panX, dpr * this.panY);
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

    // While a keyframe is being dragged the shape is drawn on top of the very
    // thing being placed - and the bigger the shape, the more completely it
    // hides it. The lights keep showing what the layer is doing, so nothing
    // about the effect is lost; only the thing in the way goes.
    const placingKey = !!(this.drag && this.drag.mode === 'move'
      && this.drag.keyIndex != null);
    if (showShapes && !placingKey) {
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

  /**
   * Start dragging one keyframe. Shared by ordinary editing and by drawing, so
   * a point behaves the same whether it was just placed or placed last week.
   */
  grabKeyframe(layer, ki, x, y, movePlayhead) {
    const app = this.app;
    const k = layer.keys[ki];
    app.pushUndo('move keyframe');
    app.selectKey(ki);
    if (movePlayhead) {
      app.setTime(layer.startMs + k.t * Math.max(1, layer.durationMs));
    }
    this.drag = {
      mode: 'move', layer, all: false, keyIndex: ki,
      grabX: x / this.cw - k.x,
      grabY: y / this.ch - k.y,
      baseKeys: layer.keys.map((kk) => ({ x: kk.x, y: kk.y })),
      baseX: k.x, baseY: k.y,
    };
  }

  /**
   * Which keyframe diamond is under the pointer, or -1.
   *
   * Only the ones drawPaths actually draws: grabbing a marker that is not on
   * screen would be worse than not grabbing one at all. Nearest wins, so
   * overlapping keyframes pick the one you are closest to rather than the
   * first in the list.
   */
  hitKeyframe(layer, x, y) {
    if (!this.app.showPath || !layer || layer.kind !== 'shape') return -1;
    let best = -1;
    let bestD = KEY_GRAB;
    for (let i = 0; i < layer.keys.length; i++) {
      const d = dist(x, y, layer.keys[i].x * this.cw, layer.keys[i].y * this.ch);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * True when the pointer is on the drawn path line.
   *
   * Sampled the same 96 ways drawPaths samples it, so what you can grab is
   * exactly what you can see - easing included, since the line bunches up where
   * the movement slows and a straight-line test would miss it there.
   */
  /**
   * Where along a layer's path the pointer is, as its 0..1 time, or null.
   *
   * The same 96 samples the path is drawn from, so the answer is a point that
   * is genuinely on the line you can see. Returning the time rather than just
   * "yes" is what lets a click insert a keyframe there: the position and the
   * moment both come from where you pointed, and neither needs the playhead.
   */
  pathTimeAt(layer, x, y) {
    if (!layer || layer.kind !== 'shape' || layer.keys.length < 2) return null;
    const steps = 96;
    let best = null;
    let px = 0;
    let py = 0;
    for (let i = 0; i <= steps; i++) {
      const st = stateAt(layer, i / steps);
      const cx = st.x * this.cw;
      const cy = st.y * this.ch;
      if (i > 0) {
        const d = segDist(x, y, px, py, cx, cy);
        if (d <= PATH_GRAB && (!best || d < best.d)) {
          // the nearer end of the segment is close enough for a 96-step curve
          const da = dist(x, y, px, py);
          const db = dist(x, y, cx, cy);
          best = { d, u: (da <= db ? i - 1 : i) / steps };
        }
      }
      px = cx;
      py = cy;
    }
    return best ? best.u : null;
  }

  /**
   * Add a keyframe where the path was clicked.
   *
   * It lands exactly on the existing curve, so adding a point does not move the
   * layer - it gives you something to grab. That is the whole reason to add one
   * here rather than at the playhead: you are pointing at the place you mean.
   */
  insertOnPath(layer, x, y) {
    const app = this.app;
    const u = this.pathTimeAt(layer, x, y);
    if (u == null) return false;
    // Already a keyframe there? Select it rather than stacking a second one on
    // the same moment, which would do nothing and look like a failure.
    const tol = 1 / 96;
    const near = layer.keys.findIndex((k) => Math.abs(k.t - u) <= tol);
    if (near >= 0) {
      app.selectKey(near);
      status('There is already a keyframe there.', 'ok');
      return true;
    }
    app.pushUndo('add keyframe');
    layer.keys.push(makeKey(u, stateAt(layer, u)));
    layer.keys.sort((a, b) => a.t - b.t);
    invalidateKeys(layer);
    app.selectKey(layer.keys.findIndex((k) => Math.abs(k.t - u) <= 1e-9));
    app.onProjectEdit({});
    app.refreshInspector();
    status(`Added a keyframe at ${Math.round(layer.startMs + u * Math.max(1, layer.durationMs))} ms `
      + '- drag it to bend the path.', 'ok');
    return true;
  }

  hitPath(layer, x, y) {
    if (!this.app.showPath || !layer || layer.kind !== 'shape') return false;
    if (layer.keys.length < 2) return false;
    const steps = 96;
    let px = 0;
    let py = 0;
    for (let i = 0; i <= steps; i++) {
      const st = stateAt(layer, i / steps);
      const cx = st.x * this.cw;
      const cy = st.y * this.ch;
      if (i > 0 && segDist(x, y, px, py, cx, cy) <= PATH_GRAB) return true;
      px = cx;
      py = cy;
    }
    return false;
  }

  drawPaths() {
    const app = this.app;
    const layer = app.selectedLayer();
    if (!layer || layer.kind !== 'shape') return;
    // Number the points while they are being placed, so the order they will be
    // travelled in is visible rather than inferred from a line.
    const numbering = !!(app.drawPath && app.drawPath.id === layer.id);
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

    // Timing dots: evenly spaced in TIME, so their spacing on screen is speed.
    // Bunched means the layer is crawling there, spread out means it is racing.
    // This is the one thing the playfield could never say before - you had to
    // scrub the timeline and watch - and it is why easing was invisible here.
    if (keys.length > 1) {
      const DOTS = 24;
      ctx.fillStyle = 'rgba(143,216,255,0.5)';
      for (let i = 0; i <= DOTS; i++) {
        const st = stateAt(layer, i / DOTS);
        ctx.beginPath();
        ctx.arc(st.x * this.cw, st.y * this.ch, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

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
      if (numbering) {
        ctx.fillStyle = '#dde4ee';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(String(i + 1), x + 7, y - 6);
      }
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
// How far past the playfield a keyframe may sit. Half a field each way is more
// than any preset uses and still far short of losing something off in space.
const offField = (v) => Math.max(-0.5, Math.min(1.5, v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
