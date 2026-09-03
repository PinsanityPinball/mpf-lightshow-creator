// Builds the four right-hand panels. Everything writes straight into the
// project and asks the app to redraw.

import { pickFile } from './filebrowser.js';
import { LAYER_STEPS } from './steps.js';
import { SHAPES, SHAPE_BY_ID, shapeDefaults } from './shapes.js';
import {
  EASE_NAMES, makeKey, invalidateKeys, projectDuration, frameCount, layerEndMs,
  layerFireTimes, setLayerStart,
  animateParam, unanimateParam, effectiveParams,
  setScaleRange, scaleRange, scaleIsUniform, fadeState, setFades,
} from './project.js';
import { showCoverage, layerMask } from './render.js';
import {
  PATHS, applyPath, TRANSFORMS, randomStart, randomEnd, SIZE_PRESETS, applySize,
  turnsOf, setTurns,
} from './paths.js';
import { orderedTargets } from './project.js';
import {
  el, clear, field, slider, selectBox, checkbox, colorInput, button, section, hint,
  rangeRow,
} from './ui.js';

const THUMB = 34;

/** Small white-on-black preview of a shape with its default parameters. */
export function shapeThumb(shapeId, params) {
  const c = document.createElement('canvas');
  c.width = THUMB; c.height = THUMB;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, THUMB, THUMB);
  const def = SHAPE_BY_ID.get(shapeId);
  if (!def) return c;
  ctx.save();
  ctx.translate(THUMB / 2, THUMB / 2);
  ctx.scale(THUMB - 6, THUMB - 6);
  ctx.fillStyle = '#8fd8ff';
  ctx.strokeStyle = '#8fd8ff';
  ctx.lineWidth = 0.02;
  try {
    def.draw(ctx, params || shapeDefaults(shapeId), def.isImage ? {} : null);
  } catch (e) { /* thumbnails never break the UI */ }
  ctx.restore();
  if (def.isImage) {
    ctx.fillStyle = '#8fd8ff';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PNG', THUMB / 2, THUMB / 2 + 3);
  }
  return c;
}

export class Inspector {
  constructor(app) {
    this.app = app;
    this.layerTab = 'shape';      // which sub-tab of the Layer panel is showing
    this.panels = {
      layer: document.getElementById('panelLayer'),
      key: document.getElementById('panelKey'),
      show: document.getElementById('panelShow'),
      export: document.getElementById('panelExport'),
    };
  }

  /**
   * Handler for a continuous control. Snapshots once per gesture, applies the
   * change, then redraws without rebuilding the panel (which would tear the
   * slider out from under the pointer).
   */
  live(key, label, fn) {
    return (v) => {
      this.app.pushUndo(label, key);
      fn(v);
      this.app.onProjectEdit({ light: true });
    };
  }

  refresh() {
    this.buildLayer();
    this.buildKey();
    this.buildShow();
    this.buildExport();
  }

  // ------------------------------------------------------------ layer

  /** Sub-tabs for the Layer panel, mirroring the wizard's steps. */
  layerTabs(layer) {
    if (layer.kind === 'pattern') {
      return [['pattern', 'Pattern'], ['lights', 'Lights']];
    }
    if (layer.kind === 'show') {
      return [['show', 'Show'], ['lights', 'Lights']];
    }
    // same list the wizard walks, so its steps and these tabs stay aligned
    return LAYER_STEPS.map((s) => [s.id, s.title]);
  }

  buildLayer() {
    const app = this.app;
    const root = clear(this.panels.layer);
    const layer = app.selectedLayer();
    if (!layer) {
      root.appendChild(el('div', { class: 'empty' }, [
        el('div', { text: app.project.layers.length
          ? 'No layer selected. Pick one from the list below.'
          : 'Nothing here yet.' }),
      ]));
      if (!app.project.layers.length) {
        root.appendChild(el('div', { class: 'btn-row', style: 'justify-content:center' }, [
          button('+ Add layer', () => app.addLayerDialog(), 'primary'),
        ]));
      }
      return;
    }
    const edit = (label, fn) => { app.pushUndo(label); fn(); app.onProjectEdit({}); };

    // ---- always-visible header: which layer, and is it on
    const name = el('input', {
      type: 'text', value: layer.name, placeholder: 'Layer name',
      title: 'What this layer is called, in the timeline and the layer list',
    });
    // commit on blur/Enter and also as you type, so a name is never lost by
    // clicking straight into another control
    const rename = () => {
      if (name.value === layer.name) return;
      app.pushUndo('rename', `${layer.id}:name`);
      layer.name = name.value;
      app.rebuildHeads();
      app.requestDraw();      // the clip label is drawn on the canvas
    };
    name.addEventListener('input', rename);
    name.addEventListener('change', rename);
    root.appendChild(el('div', { class: 'layer-head' }, [
      name,
      checkbox('On', layer.enabled, (v) => edit('enable', () => {
        layer.enabled = v; app.rebuildHeads();
      })),
    ]));

    // ---- sub-tabs
    const tabs = this.layerTabs(layer);
    if (!tabs.some(([id]) => id === this.layerTab)) this.layerTab = tabs[0][0];
    const row = el('div', { class: 'subtabs' });
    for (const [id, label] of tabs) {
      row.appendChild(el('button', {
        class: 'subtab' + (id === this.layerTab ? ' on' : ''),
        text: label,
        onclick: () => { this.layerTab = id; this.buildLayer(); },
      }));
    }
    root.appendChild(row);

    const pane = el('div', { class: 'subpane' });
    root.appendChild(pane);

    switch (this.layerTab) {
      case 'pattern': this.buildPatternLayer(pane, layer, edit); break;
      case 'show': this.buildShowLayer(pane, layer, edit); break;
      case 'lights': this.paneLights(pane, layer, edit); break;
      case 'path': this.panePath(pane, layer, edit); break;
      case 'motion': this.paneMotion(pane, layer, edit); break;
      case 'colour': this.paneColour(pane, layer, edit); break;
      case 'size': this.paneSize(pane, layer, edit); break;
      case 'timing': this.paneTiming(pane, layer, edit); break;
      default: this.paneShape(pane, layer, edit); break;
    }
  }

  // ------------------------------------------------------------ layer panes

  paneLights(root, layer, edit) {
    root.appendChild(this.buildTargetUI(layer, edit));
  }

  paneShape(root, layer, edit) {
    const app = this.app;
    root.appendChild(section('Shape'));
    const current = SHAPE_BY_ID.get(layer.shapeId);
    // the everyday shapes first; the rest read poorly on sparse lights, so they
    // sit behind a toggle rather than being removed (old shows still use them)
    const showAll = app.showAllShapes || !(current && current.common);
    const shown = SHAPES.filter((s) => s.common || showAll);
    const grid = el('div', { class: 'shape-grid' });
    for (const s of shown) {
      grid.appendChild(el('button', {
        class: 'shape-btn' + (s.id === layer.shapeId ? ' active' : ''),
        title: s.label,
        onclick: () => edit('shape', () => {
          layer.shapeId = s.id;
          layer.shapeParams = shapeDefaults(s.id);
          // the old shape's params do not exist on the new one
          layer.animParams = [];
          for (const k of layer.keys) k.params = {};
          this.buildLayer();
        }),
      }, [shapeThumb(s.id), el('span', { text: s.label })]));
    }
    root.appendChild(grid);
    const hidden = SHAPES.length - shown.length;
    if (hidden > 0 || app.showAllShapes) {
      root.appendChild(el('div', { class: 'btn-row' }, [
        button(hidden > 0 ? `Show ${hidden} more shapes` : 'Show fewer shapes', () => {
          app.showAllShapes = !app.showAllShapes;
          this.buildLayer();
        }, 'small'),
      ]));
    }

    const def = SHAPE_BY_ID.get(layer.shapeId);
    if (def && def.isImage) {
      root.appendChild(field('PNG', selectBox(layer.image,
        app.shapeFiles.length ? app.shapeFiles : [layer.image],
        (v) => edit('image', () => { layer.image = v; app.preloadImage(v); }))));
    }
    if (def) {
      const anim = layer.animParams || [];
      const live = app.stateForLayer(layer);
      for (const p of def.params) {
        if (p.type === 'bool') {
          root.appendChild(el('div', { class: 'btn-row' }, [
            checkbox(p.label, layer.shapeParams[p.key] !== false, (v) => edit(p.label, () => {
              layer.shapeParams[p.key] = v;
              this.buildLayer();
            })),
          ]));
          continue;
        }
        const animated = anim.includes(p.key);
        // an animated param reads from the keyframe under the playhead
        const cur = animated
          ? effectiveParams(layer, live)[p.key]
          : (layer.shapeParams[p.key] == null ? p.def : layer.shapeParams[p.key]);

        const toggle = el('button', {
          class: 'anim-btn' + (animated ? ' on' : ''),
          html: '&#9670;',
          title: animated
            ? 'Animated - click to freeze at the current value'
            : 'Animate this over the clip',
          onclick: () => edit('animate param', () => {
            if (animated) unanimateParam(layer, p.key);
            else animateParam(layer, p.key);
            this.buildLayer();
          }),
        });

        root.appendChild(slider(p.label, cur == null ? p.def : cur, p,
          (v) => {
            app.pushUndo(p.label, `${layer.id}:shape:${p.key}`);
            if (layer.animParams.includes(p.key)) {
              const k = app.targetKey(layer);
              if (k) { k.params = k.params || {}; k.params[p.key] = v; }
            } else {
              layer.shapeParams[p.key] = v;
            }
            app.onProjectEdit({ light: true });
          }, toggle));
      }
      root.appendChild(hint(anim.length
        ? `${anim.join(', ')} ${anim.length === 1 ? 'is' : 'are'} animated: the slider `
          + 'writes to the keyframe at the playhead, exactly like dragging the shape '
          + 'does. Scrub, adjust, repeat.'
        : 'Click a diamond to animate that parameter over the clip - that is how you '
          + 'get a pie chart that fills or a ring that grows.'));
      root.appendChild(el('div', { class: 'btn-row' }, [
        button('Reset shape params', () => edit('reset shape', () => {
          layer.shapeParams = shapeDefaults(layer.shapeId);
          (layer.animParams || []).slice().forEach((n) => unanimateParam(layer, n));
          layer.animParams = [];
          this.buildLayer();
        }), 'small'),
      ]));
    }

  }

  /**
   * Fire the same layer more than once.
   *
   * A gesture that repeats at irregular times used to need one layer object per
   * firing. Across the saved shows, 63-71% of every layer is an exact duplicate
   * of another differing only in start time - one file has 291 copies of a
   * single gesture. Listing the extra times here collapses all of that into one
   * layer, and each firing can be varied so a train does not look mechanical.
   */
  paneRepeats(root, layer, edit) {
    const app = this.app;
    const times = layerFireTimes(layer);
    const span = Math.max(1, layer.durationMs) * Math.max(1, layer.repeat || 1);

    root.appendChild(section('Fire again'));

    if (times.length <= 1) {
      root.appendChild(hint('This layer fires once. Give it more start times and the '
        + 'same animation runs again at each of them, overlapping freely - one layer '
        + 'instead of a copy per firing.'));
      const every = el('input', { type: 'number', value: Math.max(50, span), min: 10, step: 10 });
      const count = el('input', { type: 'number', value: 4, min: 2, max: 500, step: 1 });
      root.appendChild(field('Every (ms)', every));
      root.appendChild(field('How many', count));
      root.appendChild(el('div', { class: 'btn-row' }, [
        button('Add repeats', () => edit('repeat layer', () => {
          const gap = Math.max(10, Math.round(Number(every.value) || span));
          const n = Math.max(2, Math.min(500, Math.round(Number(count.value) || 2)));
          const out = [];
          for (let i = 0; i < n; i++) out.push(layer.startMs + i * gap);
          layer.at = out;
          this.buildLayer();
          app.rebuildHeads();
        }), 'primary small'),
      ]));
      return;
    }

    const last = times[times.length - 1];
    root.appendChild(hint(`Fires ${times.length} times, from ${times[0]} to ${last} ms. `
      + `Each run lasts ${span} ms, so `
      + (times.length > 1 && times[1] - times[0] < span
        ? 'firings overlap.' : 'they do not overlap.')));

    const list = el('textarea', {
      rows: 3, class: 'at-list',
      value: times.join(', '),
      title: 'Start times in milliseconds, separated by commas or spaces',
    });
    list.addEventListener('change', () => edit('fire times', () => {
      const parsed = String(list.value).split(/[^0-9.-]+/)
        .map((v) => Math.round(Number(v)))
        .filter((v) => Number.isFinite(v) && v >= 0);
      layer.at = parsed.length ? parsed.sort((a, b) => a - b) : [];
      if (layer.at.length) layer.startMs = layer.at[0];
      this.buildLayer();
      app.rebuildHeads();
    }));
    root.appendChild(field('Start times', list));

    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Shift to playhead', () => edit('shift repeats', () => {
        // clamp the whole run, not each time separately: clamping individually
        // collapsed early firings onto 0 and fired them twice at the same instant
        const delta = Math.max(-times[0], Math.round(app.renderTime()) - times[0]);
        layer.at = times.map((t) => t + delta);
        layer.startMs = layer.at[0];
        this.buildLayer();
        app.rebuildHeads();
      }), 'small'),
      button('Back to one', () => edit('single firing', () => {
        layer.at = [];
        this.buildLayer();
        app.rebuildHeads();
      }), 'small danger'),
    ]));

    // Vary walks a shape layer's own state - position, size, colour. A pattern
    // drives lights from its own settings and never reads that state, so the
    // controls would do nothing at all there.
    if (layer.kind !== 'shape') {
      root.appendChild(hint('Each firing of a pattern layer is identical. Varying '
        + 'position, size or colour per firing only applies to shape layers.'));
      return;
    }

    // --- per-firing variation
    const v = layer.vary || {};
    root.appendChild(section('Vary each firing'));
    root.appendChild(slider('Hue shift per firing', v.hue || 0,
      { min: -90, max: 90, step: 1 }, (val) => {
        app.pushUndo('vary hue', `${layer.id}:varyhue`);
        layer.vary = Object.assign({}, layer.vary, { hue: val });
        if (!val) delete layer.vary.hue;
        if (!Object.keys(layer.vary).length) layer.vary = null;
        app.onProjectEdit({ light: true });
      }));
    root.appendChild(hint(v.hue
      ? `Firing ${times.length} is ${Math.round(v.hue * (times.length - 1))} degrees `
        + 'round the wheel from the first. Cumulative, so a long train drifts through '
        + 'the spectrum instead of flicking between a few colours.'
      : 'Cumulative degrees per firing. Leave at 0 and every firing is the same colour.'));

    const posList = (key, label) => {
      const box = el('input', {
        type: 'text', value: (v[key] || []).join(', '),
        placeholder: 'e.g. 0.2, 0.5, 0.8',
        title: 'Values cycled by firing, so three values across ten firings repeat 1-2-3',
      });
      box.addEventListener('change', () => edit('vary ' + label, () => {
        const parsed = String(box.value).split(/[^0-9.-]+/)
          .map(Number).filter((n) => Number.isFinite(n));
        layer.vary = Object.assign({}, layer.vary);
        if (parsed.length) layer.vary[key] = parsed;
        else delete layer.vary[key];
        if (!Object.keys(layer.vary).length) layer.vary = null;
        this.buildLayer();
      }));
      root.appendChild(field(label, box));
    };
    posList('x', 'Nudge across');
    posList('y', 'Nudge up/down');
    posList('scale', 'Size multiplier');
    root.appendChild(hint('Offsets, not fixed values: the layer keeps its own animation '
      + 'and each firing is shifted by these. Across and up/down are added (0.1 is a '
      + 'tenth of the playfield), size multiplies (0.5 is half). Each list cycles by '
      + 'firing number, so a few values cover any number of firings.'));
  }

  paneSize(root, layer, edit) {
    const app = this.app;
    const rx = scaleRange(layer, 'x');
    const ry = scaleRange(layer, 'y');
    const uniform = scaleIsUniform(layer);
    const spec = { min: 0.02, max: 3, step: 0.01 };
    const redraw = () => app.requestDraw();

    root.appendChild(section('Size'));
    root.appendChild(el('div', { class: 'btn-row' },
      SIZE_PRESETS.map((sz) => button(sz.label, () => edit('size ' + sz.label, () => {
        applySize(layer, sz.scale, true);
        app.refreshInspector();
      }), 'small'))));
    root.appendChild(hint('Sets every keyframe to that size. The Keyframe tab sizes '
      + 'one keyframe on its own.'));

    root.appendChild(section('Start and end'));
    if (uniform) {
      root.appendChild(rangeRow('Scale', spec, rx, (from, to) => {
        app.pushUndo('scale', layer.id + ':scale');
        setScaleRange(layer, from, to, 'both');
        app.onProjectEdit({ light: true });
      }, redraw));
      root.appendChild(el('div', { class: 'btn-row' }, [
        button('Separate width & height', () => edit('separate axes', () => {
          setScaleRange(layer, rx.from, rx.to, 'x');
          this.buildLayer();
        }), 'small'),
      ]));
      root.appendChild(hint('Width and height move together. Give the two ends '
        + 'different values to grow or shrink over the clip.'));
    } else {
      root.appendChild(rangeRow('Width', spec, rx, (from, to) => {
        app.pushUndo('width', layer.id + ':scaleX');
        setScaleRange(layer, from, to, 'x');
        app.onProjectEdit({ light: true });
      }, redraw));
      root.appendChild(rangeRow('Height', spec, ry, (from, to) => {
        app.pushUndo('height', layer.id + ':scaleY');
        setScaleRange(layer, from, to, 'y');
        app.onProjectEdit({ light: true });
      }, redraw));
      root.appendChild(el('div', { class: 'btn-row' }, [
        button('Match height to width', () => edit('match axes', () => {
          setScaleRange(layer, rx.from, rx.to, 'both');
          this.buildLayer();
        }), 'small'),
      ]));
    }
  }

  panePath(root, layer, edit) {
    const app = this.app;
    root.appendChild(section('Motion path'));
    const pathRow = el('div', { class: 'btn-row' });
    for (const p of PATHS) {
      pathRow.appendChild(button(p.label, () => edit('path: ' + p.label, () => {
        applyPath(layer, p.id, {
          aspect: app.project.aspect || 0.5,
          points: p.id === 'diagonal' || p.id === 'sweep-up' ? 2
            : (p.id === 'sides' ? 4 : 24),
        });
        app.selectKey(0);
        this.app.refreshInspector();
      }), 'small'));
    }
    root.appendChild(pathRow);
    root.appendChild(hint('A path rewrites only where the shape goes. Colour, size, '
      + 'rotation and any animated shape params are resampled, so the rest of your '
      + 'setup survives.'));

    root.appendChild(section('Transform'));
    root.appendChild(el('div', { class: 'btn-row' },
      TRANSFORMS.map((tr) => button(tr.label, () => edit(tr.label, () => {
        tr.apply(layer);
        invalidateKeys(layer);
        this.app.refreshInspector();
      }), 'small'))));

    root.appendChild(section('Randomise'));
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Random start', () => edit('random start', () => {
        randomStart(layer); invalidateKeys(layer); this.app.refreshInspector();
      }), 'small'),
      button('Random exit', () => edit('random exit', () => {
        randomEnd(layer); invalidateKeys(layer); this.app.refreshInspector();
      }), 'small'),
      button('Both', () => edit('randomise path', () => {
        randomStart(layer); randomEnd(layer); invalidateKeys(layer); this.app.refreshInspector();
      }), 'small'),
    ]));
    root.appendChild(hint('Random start lands in the middle half of the playfield; '
      + 'random exit puts the last keyframe just off one edge.'));
  }

  paneMotion(root, layer, edit) {
    const turns = turnsOf(layer);
    root.appendChild(section('Rotation'));
    root.appendChild(field('Rotations', numberInput(Math.round(turns * 100) / 100, -50, 50, 0.5,
      (v) => edit('rotations', () => { setTurns(layer, v); this.buildLayer(); })),
      { title: 'Full turns over the clip' }));
    root.appendChild(el('div', { class: 'btn-row' },
      [-2, -1, 1, 2, 3, 5].map((n) => button(n > 0 ? `+${n}` : String(n),
        () => edit('rotations', () => { setTurns(layer, n); this.buildLayer(); }), 'small'))));
    root.appendChild(hint(layer.keys.length < 2
      ? 'Rotation needs at least two keyframes to spin between.'
      : `${turns === 0 ? 'No rotation' : `${Math.round(turns * 360)}° total`}, spread `
        + 'evenly over the clip by time, so the spin is at a constant rate. '
        + 'Negative turns go the other way.'));

    root.appendChild(section('Keyframes'));
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Reverse', () => edit('reverse', () => {
        layer.keys = layer.keys.map((k) => Object.assign({}, k, { t: 1 - k.t }))
          .sort((a, b) => a.t - b.t);
        // easings belong to the segment that follows a key, so shift them along
        const eases = layer.keys.map((k) => k.ease);
        layer.keys.forEach((k, i) => { k.ease = eases[Math.max(0, i - 1)]; });
        invalidateKeys(layer);
        this.app.refreshInspector();
      }), 'small'),
      button('Space evenly', () => edit('space keys', () => {
        const n = layer.keys.length;
        layer.keys.sort((a, b) => a.t - b.t).forEach((k, i) => { k.t = n === 1 ? 0 : i / (n - 1); });
        invalidateKeys(layer);
      }), 'small'),
      button('Ease all', () => edit('ease all', () => {
        layer.keys.forEach((k) => { k.ease = 'sine-in-out'; });
        this.app.refreshInspector();
      }), 'small'),
    ]));
    const fades = fadeState(layer);
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Fade in', fades.in, (v) => edit('fade in', () => {
        setFades(layer, v, fades.out);
        this.buildLayer();
      })),
      checkbox('Fade out', fades.out, (v) => edit('fade out', () => {
        setFades(layer, fades.in, v);
        this.buildLayer();
      })),
    ]));
    root.appendChild(hint('Double-click a clip in the timeline to add a keyframe. '
      + 'Drag the shape on the playfield to move it.'));
  }

  paneColour(root, layer, edit) {
    root.appendChild(section('Colour'));
    root.appendChild(field('Fill', selectBox(layer.colorMode, [
      ['solid', 'Solid'], ['gradient', 'Two-colour gradient'], ['rainbow', 'Rainbow'],
    ], (v) => edit('colour mode', () => { layer.colorMode = v; this.buildLayer(); }))));
    root.appendChild(field('Tween in', selectBox(layer.colorLerp, [
      ['rgb', 'RGB (direct)'], ['hsl', 'HSL (through hues)'],
    ], (v) => edit('colour tween', () => { layer.colorLerp = v; }))));
    if (layer.colorMode === 'rainbow') {
      root.appendChild(slider('Hue spread', layer.rainbowSpread, { min: 30, max: 1080, step: 5 },
        this.live(`${layer.id}:hueSpread`, 'hue spread', (v) => { layer.rainbowSpread = v; })));
      root.appendChild(slider('Hue offset', layer.rainbowOffset, { min: 0, max: 360, step: 1 },
        this.live(`${layer.id}:hueOffset`, 'hue offset', (v) => { layer.rainbowOffset = v; })));
      root.appendChild(hint('Rainbow ignores the keyframe colours.'));
    } else {
      root.appendChild(hint('Per-keyframe colours live on the Keyframe tab. '
        + 'HSL tweening walks around the colour wheel instead of through grey.'));
    }
  }

  paneTiming(root, layer, edit) {
    root.appendChild(section('Timing'));
    root.appendChild(field('Start (ms)', numberInput(layer.startMs, 0, 600000, 1,
      (v) => edit('start', () => { setLayerStart(layer, v); }))));
    root.appendChild(field('Length (ms)', numberInput(layer.durationMs, 16, 600000, 1,
      (v) => edit('length', () => { layer.durationMs = Math.max(16, v); }))));
    root.appendChild(field('Repeat', numberInput(layer.repeat || 1, 1, 200, 1,
      (v) => edit('repeat', () => { layer.repeat = Math.max(1, Math.round(v)); }))));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Ping-pong', layer.pingpong, (v) => edit('pingpong', () => { layer.pingpong = v; })),
    ]));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Visible before', layer.holdBefore, (v) => edit('hold', () => { layer.holdBefore = v; })),
      checkbox('Visible after', layer.holdAfter, (v) => edit('hold', () => { layer.holdAfter = v; })),
    ]));
    root.appendChild(hint(`Ends at ${Math.round(layerEndMs(layer))} ms.`));

    this.paneRepeats(root, layer, edit);

    root.appendChild(section('Blend'));
    root.appendChild(field('Mode', selectBox(layer.blend, [
      ['add', 'Add (lights stack)'], ['normal', 'Normal (covers)'],
      ['average', 'Average (blends colours)'],
      ['erase', 'Erase (turns lights off)'],
    ], (v) => edit('blend', () => { layer.blend = v; this.buildLayer(); }))));
    if (layer.blend === 'erase') {
      root.appendChild(hint('Erase does not light anything. Wherever it covers a light it switches '
        + 'that light off, so it only affects layers below it in the list. Use it '
        + 'to punch a moving hole in something, or to hold a group dark while the '
        + 'rest of the show runs.'));
    }
    if (layer.blend === 'average') {
      root.appendChild(hint('Every averaging layer reaching a light is mixed into one colour '
        + 'rather than added, so red over blue gives purple instead of magenta-white. '
        + 'The result is scaled back up to the brightest layer that reached it, so '
        + 'mixing does not dim the light. Averaging layers mix with each other; '
        + 'anything on Add still stacks on top.'));
    }
  }

  /**
   * Destination picker. Lists the app's own exports folder, every machine
   * folder remembered so far, and any found by scanning the usual places.
   */
  buildDestinationUI() {
    const app = this.app;
    const cfg = app.config || {};
    const data = app.folders || { folders: [], discovered: [] };
    const wrap = el('div');

    // Written without literal backslashes so the source stays unambiguous.
    const SEP = String.fromCharCode(92);
    const short = (p) => {
      const parts = String(p).split(SEP).join('/').split('/')
        .filter(Boolean);
      return parts.length > 2 ? '\u2026' + SEP + parts.slice(-2).join(SEP) : p;
    };

    const options = [['exports', 'This app: exports folder']];
    for (const f of data.folders || []) {
      options.push([f.path, short(f.path) + (f.ok ? '' : '  (missing)')]);
    }
    for (const f of data.discovered || []) {
      options.push([f.path, short(f.path) + '  (found)']);
    }
    options.push(['__browse__', 'Browse for a folder\u2026']);
    options.push(['__add__', 'Type a path\u2026']);

    const current = app.destination();
    const sel = selectBox(
      options.some((o) => o[0] === current) ? current : 'exports',
      options,
      (v) => {
        if (v === '__browse__') { this.browseForFolder(); return; }
        if (v === '__add__') { this.showAddFolder(wrap); return; }
        app.setDestination(v);
      },
      'Where Export show writes the file');
    wrap.appendChild(field('Write to', sel));

    if (current === 'exports') {
      wrap.appendChild(hint('Writes to ' + (data.exportsDir || 'the exports folder') + '.'));
    } else {
      wrap.appendChild(hint(cfg.machineOk
        ? 'Writes to ' + cfg.machineShowsDir
        : 'Not reachable: ' + (cfg.machineMessage || current)));
      wrap.appendChild(el('div', { class: 'btn-row' }, [
        button('Forget this folder', () => app.forgetFolder(current), 'small danger'),
      ]));
    }
    if ((data.discovered || []).length) {
      const n = data.discovered.length;
      wrap.appendChild(hint(`${n} machine folder${n === 1 ? '' : 's'} found nearby are `
        + 'listed as "(found)". Picking one remembers it.'));
    }
    return wrap;
  }

  /** Walk the disk for a machine folder, rather than typing its path. */
  async browseForFolder() {
    const app = this.app;
    const current = app.destination();
    const path = await pickFile({
      title: 'Choose an export folder', mode: 'folder',
      startAt: current === 'exports' ? '' : current,
    });
    if (!path) { this.buildExport(); return; }
    // setDestination validates the folder and reports why if it will not work
    app.setDestination(path);
  }

  /** Inline row for typing a path the scan did not find. */
  showAddFolder(wrap) {
    const app = this.app;
    const sep = String.fromCharCode(92);
    const input = el('input', {
      type: 'text',
      placeholder: ['C:', 'path', 'to', 'your_machine'].join(sep),
    });
    const add = () => {
      const v = input.value.trim();
      if (v) app.setDestination(v); else this.buildExport();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    wrap.appendChild(el('div', {}, [
      field('Folder', input),
      el('div', { class: 'btn-row' }, [
        button('Add', add, 'primary small'),
        button('Cancel', () => this.buildExport(), 'small'),
      ]),
      hint('Paste the path to your MPF machine folder. If it contains a config/ '
        + 'folder, shows go into its shows/ subfolder.'),
    ]));
    input.focus();
  }

  /** Tag picker deciding which lights a layer is allowed to affect. */
  buildTargetUI(layer, edit) {
    const app = this.app;
    const t = layer.target;
    const wrap = el('div');

    wrap.appendChild(field('Lights', selectBox(t.mode, [
      ['all', 'Every light'], ['tags', 'Only these tags'],
    ], (v) => edit('target mode', () => { t.mode = v; this.buildLayer(); }))));

    if (t.mode !== 'tags') return wrap;

    if (!app.tags.length) {
      wrap.appendChild(hint('No tags loaded. Pick a lights.yaml in the Tags dropdown '
        + 'at the top, or import one from the Show tab.'));
      return wrap;
    }

    const chips = el('div', { class: 'chips' });
    for (const { tag, count } of app.tags) {
      const on = t.tags.includes(tag);
      chips.appendChild(el('button', {
        class: 'chip' + (on ? ' on' : ''),
        title: `${count} light${count === 1 ? '' : 's'} tagged "${tag}"`,
        onclick: () => edit('target tags', () => {
          const i = t.tags.indexOf(tag);
          if (i >= 0) t.tags.splice(i, 1); else t.tags.push(tag);
          this.buildLayer();
        }),
      }, [el('span', { text: tag }), el('i', { text: String(count) })]));
    }
    wrap.appendChild(chips);

    wrap.appendChild(field('Match', selectBox(t.match, [
      ['any', 'Any of the tags'], ['all', 'All of the tags'],
    ], (v) => edit('tag match', () => { t.match = v; this.buildLayer(); }))));
    wrap.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Invert (everything else)', t.invert,
        (v) => edit('tag invert', () => { t.invert = v; this.buildLayer(); })),
    ]));

    wrap.appendChild(el('div', { class: 'sec', text: 'But never these' }));
    const ex = el('div', { class: 'chips' });
    for (const { tag, count } of app.tags) {
      const on = (t.exclude || []).includes(tag);
      ex.appendChild(el('button', {
        class: 'chip' + (on ? ' off' : ''),
        title: `Exclude the ${count} light${count === 1 ? '' : 's'} tagged "${tag}"`,
        onclick: () => edit('exclude tags', () => {
          t.exclude = t.exclude || [];
          const i = t.exclude.indexOf(tag);
          if (i >= 0) t.exclude.splice(i, 1); else t.exclude.push(tag);
          this.buildLayer();
        }),
      }, [el('span', { text: tag }), el('i', { text: String(count) })]));
    }
    wrap.appendChild(ex);
    wrap.appendChild(hint('Exclusions are applied last, so you can say "every shot '
      + 'light, but not the strip".'));

    const n = app.countTargeted(layer);
    wrap.appendChild(hint(t.tags.length
      ? `${n} of ${app.lights.length} lights selected - they are ringed in orange on the playfield.`
      : 'No tags picked yet, so this layer currently drives nothing.'));
    return wrap;
  }

  /**
   * Warn when a pattern time is not a whole number of frames. The sampler can
   * only switch on a frame boundary, so 120ms at 30Hz actually lands on 100ms.
   */
  quantiseHint(ms, fps, what) {
    const frames = (ms * fps) / 1000;
    const nearest = Math.max(1, Math.round(frames));
    if (Math.abs(frames - nearest) < 0.02) return null;
    const actual = Math.round((Math.floor(frames) || 1) * (1000 / fps));
    const suggest = Math.round(nearest * (1000 / fps));
    return hint(`${what} of ${ms} ms is ${frames.toFixed(2)} frames at ${fps} Hz, so it `
      + `lands on ${actual} ms. Use ${suggest} ms, or raise the sample rate, to hit it exactly.`);
  }

  /** Panel for a blink / chase pattern driven straight onto tagged lights. */
  buildPatternLayer(root, layer, edit) {
    const app = this.app;
    const p = layer.pattern;
    const count = app.countTargeted(layer);

    root.appendChild(section('Pattern'));
    root.appendChild(field('Type', selectBox(p.type, [
      ['blink', 'Blink on and off'],
      ['chase', 'Chase through the lights'],
      ['sparkle', 'Sparkle (random lights)'],
      ['wavy', 'Wave across the lights'],
      ['stack', 'Stack / fill a grid'],
      ['marquee', 'Marquee (every Nth light)'],
      ['fire', 'Fire (flicker, hot at the base)'],
      ['pinwheel', 'Pinwheel (arms spinning)'],
      ['scanner', 'Scanner (band sweeping back and forth)'],
      ['rain', 'Rain (drops falling)'],
      ['plasma', 'Plasma (soft moving wash)'],
      ['contagion', 'Contagion (spreads light to light)'],
      ['comet', 'Comet (thrown, bounces)'],
      ['sweep', 'Sweep (tag group by group)'],
      ['interference', 'Interference (two waves beating)'],
      ['voronoi', 'Voronoi (drifting territories)'],
      ['solid', 'Solid colour'],
    ], (v) => edit('pattern type', () => { p.type = v; this.buildLayer(); }))));
    const FIT_MEANS = {
      stack: 'one complete fill spanning the clip',
      chase: 'exactly one pass along the lights',
      marquee: 'a whole number of complete cycles',
      wavy: 'a whole number of passes',
      fire: 'a whole number of flicker cycles',
      pinwheel: 'a whole number of turns',
      scanner: 'a whole number of sweeps',
      rain: 'a whole number of falls',
      plasma: 'a whole number of cycles',
      contagion: 'one complete spread',
      comet: 'a whole number of throws',
      sweep: 'one pass through the tag groups',
      interference: 'a whole number of passes',
      voronoi: 'one full drift',
      solid: 'a whole number of pulses',
      blink: 'a whole number of pulses',
    };
    if (FIT_MEANS[p.type]) {
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Fit to layer length', p.fit !== false, (v) => edit('fit to layer', () => {
          p.fit = v;
          this.buildLayer();
        })),
      ]));
      root.appendChild(hint(p.fit !== false
        ? `Timed to the clip: ${FIT_MEANS[p.type]} over its ${layer.durationMs} ms. `
          + 'Resize the clip and the pattern stretches with it.'
        : 'Running on its own timing, which is unrelated to the clip length - it can '
          + 'finish early and hold, or be cut off mid-cycle.'));
    }

    if (p.type !== 'sparkle') {
      root.appendChild(field('Colour', colorInput(p.color,
        this.live(`${layer.id}:pcolor`, 'colour', (v) => { p.color = v; app.rebuildHeads(); }))));
    }

    if (p.type === 'sparkle') {
      root.appendChild(field('Lit at once', numberInput(p.count, 1, 200, 1,
        (v) => edit('sparkle count', () => { p.count = Math.max(1, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(field('Re-pick every (ms)', numberInput(p.stepMs, 10, 10000, 10,
        (v) => edit('sparkle rate', () => { p.stepMs = Math.max(10, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(slider('Trail (steps)', p.life, { min: 1, max: 8, step: 1 },
        this.live(`${layer.id}:plife`, 'sparkle trail', (v) => { p.life = Math.round(v); })));
      root.appendChild(slider('Fade out', p.decay, { min: 0, max: 1, step: 0.05 },
        this.live(`${layer.id}:pdecay`, 'sparkle fade', (v) => { p.decay = v; })));
      root.appendChild(section('Palette'));
      root.appendChild(this.buildPalette(layer, edit));
      root.appendChild(field('Seed', numberInput(p.seed, 1, 9999, 1,
        (v) => edit('sparkle seed', () => { p.seed = Math.round(v); this.buildLayer(); }))));
      root.appendChild(hint('The pattern is random but repeatable: the same seed always '
        + 'gives the same show, so the preview and the export match exactly. '
        + 'Change the seed to roll a different arrangement.'));
    }

    if (p.type === 'wavy') {
      root.appendChild(field('Travels', selectBox(p.axis, [
        ['radial', 'Out from the centre'],
        ['y', 'Up the playfield'], ['x', 'Across the playfield'],
      ], (v) => edit('wave axis', () => { p.axis = v; this.buildLayer(); }))));
      root.appendChild(field('Trough colour', colorInput(p.waveColor2 || p.color,
        this.live(`${layer.id}:pwc2`, 'trough colour', (v) => { p.waveColor2 = v; }))));
      if (p.waveColor2) {
        root.appendChild(el('div', { class: 'btn-row' }, [
          button('One colour only', () => edit('one colour', () => {
            p.waveColor2 = '';
            this.buildLayer();
          }), 'small'),
        ]));
      }
      root.appendChild(slider('Wavelength', p.wavelength, { min: 0.05, max: 2, step: 0.05 },
        this.live(`${layer.id}:pwl`, 'wavelength', (v) => { p.wavelength = v; })));
      root.appendChild(field('Cycle (ms)', numberInput(p.periodMs, 50, 60000, 50,
        (v) => edit('wave period', () => { p.periodMs = Math.max(50, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(slider('Trough brightness', p.floorLevel, { min: 0, max: 1, step: 0.05 },
        this.live(`${layer.id}:pfloor`, 'trough', (v) => { p.floorLevel = v; })));
      root.appendChild(slider('Crest sharpness', p.sharpness, { min: 0.2, max: 6, step: 0.1 },
        this.live(`${layer.id}:psharp`, 'sharpness', (v) => { p.sharpness = v; })));
      // "Seamless loop" and "Fit to layer length" were ANDed in the renderer, so
      // each read as on while the other silently disabled it. Fit is the one
      // that acts, and it is offered on every pattern, so this copy is gone.
      const cycles = Math.max(1, Math.round(layer.durationMs / Math.max(1, p.periodMs)));
      root.appendChild(hint('The wave runs across the real light positions, so it follows '
        + 'your playfield layout rather than a drawn shape.'
        + (p.fit !== false
          ? ` Fit rounds the cycle to ${cycles} whole `
            + `${cycles === 1 ? 'pass' : 'passes'} across the clip `
            + `(${Math.round(layer.durationMs / cycles)} ms each), so the wave does not `
            + 'jump when the layer repeats.'
          : ' With Fit off the wave is mid-stroke when the clip ends, which shows '
            + 'as a jump each time the layer repeats.')));
      if (p.waveColor2) {
        root.appendChild(hint('With a trough colour the wave washes between two colours. '
          + 'It needs Trough brightness above 0 to be visible at all.'));
      }
    }

    if (p.type === 'stack') {
      root.appendChild(field('Second colour', colorInput(p.color2,
        this.live(`${layer.id}:pcolor2`, 'colour', (v) => { p.color2 = v; }))));
      root.appendChild(slider('Columns', p.cols, { min: 1, max: 16, step: 1 },
        this.live(`${layer.id}:pcols`, 'columns', (v) => { p.cols = Math.round(v); })));
      root.appendChild(slider('Rows', p.rows, { min: 1, max: 24, step: 1 },
        this.live(`${layer.id}:prows`, 'rows', (v) => { p.rows = Math.round(v); })));
      if (p.fit !== false) {
        root.appendChild(hint('Fit to layer length is on, so the fill takes the '
          + `whole clip: ${layer.durationMs} ms. Turn Fit off to set the fill `
          + 'time directly.'));
      } else
      root.appendChild(field('Fill time (ms)', numberInput(p.fillMs, 50, 120000, 50,
        (v) => edit('fill time', () => { p.fillMs = Math.max(50, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(field('Fills', selectBox(p.fillOrder, [
        ['bottom-up', 'Bottom to top'], ['top-down', 'Top to bottom'],
        ['left-right', 'Left to right'], ['right-left', 'Right to left'],
      ], (v) => edit('fill order', () => { p.fillOrder = v; this.buildLayer(); }))));
      root.appendChild(field('Mode', selectBox(p.fillMode, [
        ['fill', 'Cells stay lit'], ['wipe', 'Only the leading cell'],
      ], (v) => edit('fill mode', () => { p.fillMode = v; this.buildLayer(); }))));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Show pieces falling', p.drop !== false, (v) => edit('stack drop', () => {
          p.drop = v;
          this.buildLayer();
        })),
      ]));
      if (p.drop !== false) {
        root.appendChild(slider('Falling brightness', p.dropTrail, { min: 0.05, max: 1, step: 0.05 },
          this.live(`${layer.id}:pdrop`, 'falling brightness', (v) => { p.dropTrail = v; })));
      }
      root.appendChild(hint(`${p.cols} x ${p.rows} = ${p.cols * p.rows} cells over `
        + `${p.fillMs} ms, so a cell lands every ${Math.round(p.fillMs / (p.cols * p.rows))} ms.`
        + (p.drop !== false
          ? ' Each piece travels in from the edge to its resting cell rather than '
            + 'appearing there, so you watch it fall into place.'
            + (p.cols * p.rows > 40 ? ' With this many cells each fall is very quick - '
              + 'fewer cells or a longer fill time makes the movement readable.' : '')
          : '')));
    }

    if (p.type === 'marquee') {
      root.appendChild(slider('One light in every', p.every, { min: 2, max: 8, step: 1 },
        this.live(`${layer.id}:pevery`, 'every', (v) => { p.every = Math.round(v); })));
      root.appendChild(field('Step (ms)', numberInput(p.marqueeMs, 20, 5000, 10,
        (v) => edit('marquee step', () => {
          p.marqueeMs = Math.max(20, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(field('Order by', selectBox(p.order, [
        ['name', 'Light name'], ['x', 'Left to right'], ['y', 'Top to bottom'],
        ['angle', 'Around the centre'],
      ], (v) => edit('marquee order', () => { p.order = v; this.buildLayer(); }))));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Reverse direction', !!p.reverse, (v) => edit('marquee direction', () => {
          p.reverse = v;
          this.buildLayer();
        })),
      ]));
      root.appendChild(field('When off', selectBox(p.offMode, [
        ['dark', 'Dark'], ['colour', 'Another colour'],
      ], (v) => edit('off mode', () => { p.offMode = v; this.buildLayer(); }))));
      if (p.offMode === 'colour') {
        root.appendChild(field('Off colour', colorInput(p.offColor,
          this.live(`${layer.id}:pmoff`, 'off colour', (v) => { p.offColor = v; }))));
      }
      root.appendChild(hint('A theatre sign: every Nth light is lit and the lit set steps '
        + 'along one place at a time. It reads as movement without a moving shape, and it '
        + 'suits a ring or a row of lights better than a scattered group.'));
    }

    if (p.type === 'fire') {
      root.appendChild(field('Cool colour', colorInput(p.color2,
        this.live(`${layer.id}:pfc2`, 'cool colour', (v) => { p.color2 = v; }))));
      root.appendChild(slider('Heat', p.fireHeat, { min: 0, max: 1, step: 0.02 },
        this.live(`${layer.id}:pfh`, 'heat', (v) => { p.fireHeat = v; })));
      root.appendChild(slider('Flicker', p.fireJitter, { min: 0, max: 1, step: 0.02 },
        this.live(`${layer.id}:pfj`, 'flicker', (v) => { p.fireJitter = v; })));
      root.appendChild(field('Re-roll (ms)', numberInput(p.fireMs, 20, 2000, 10,
        (v) => edit('flicker rate', () => {
          p.fireMs = Math.max(20, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(field('Seed', numberInput(p.seed, 1, 9999, 1,
        (v) => edit('seed', () => { p.seed = Math.round(v); this.buildLayer(); }))));
      root.appendChild(hint('Hottest at the bottom of the group, cooling towards the top, '
        + 'with every light flickering on its own. Seeded, so the same show burns the '
        + 'same way every time.'));
    }

    if (p.type === 'pinwheel') {
      root.appendChild(slider('Arms', p.arms, { min: 1, max: 8, step: 1 },
        this.live(`${layer.id}:parms`, 'arms', (v) => { p.arms = Math.round(v); })));
      root.appendChild(field('Turn time (ms)', numberInput(p.spinMs, 100, 60000, 50,
        (v) => edit('spin time', () => {
          p.spinMs = Math.max(100, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(slider('Arm width', p.armWidth, { min: 0.05, max: 1, step: 0.01 },
        this.live(`${layer.id}:paw`, 'arm width', (v) => { p.armWidth = v; })));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Spin the other way', !!p.reverse, (v) => edit('spin direction', () => {
          p.reverse = v;
          this.buildLayer();
        })),
      ]));
      root.appendChild(hint('Works off the angle of each light around the centre, so the '
        + 'arms stay even however the lights are scattered.'));
    }

    if (p.type === 'scanner') {
      root.appendChild(field('Sweeps', selectBox(p.axis === 'x' ? 'x' : 'y', [
        ['y', 'Up and down'], ['x', 'Left and right'],
      ], (v) => edit('scanner axis', () => { p.axis = v; this.buildLayer(); }))));
      root.appendChild(field('Sweep time (ms)', numberInput(p.sweepMs, 100, 60000, 50,
        (v) => edit('sweep time', () => {
          p.sweepMs = Math.max(100, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(slider('Band width', p.bandWidth, { min: 0.03, max: 0.6, step: 0.01 },
        this.live(`${layer.id}:pbw`, 'band width', (v) => { p.bandWidth = v; })));
      root.appendChild(slider('Trail', p.tailLen, { min: 0, max: 0.8, step: 0.02 },
        this.live(`${layer.id}:ptail`, 'trail', (v) => { p.tailLen = v; })));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Bounce back', p.bounce !== false, (v) => edit('bounce', () => {
          p.bounce = v;
          this.buildLayer();
        })),
        checkbox('Start the other way', !!p.reverse, (v) => edit('scan direction', () => {
          p.reverse = v;
          this.buildLayer();
        })),
      ]));
      root.appendChild(hint('Without Bounce back the band wraps round and starts again '
        + 'from the same edge instead of returning.'));
    }

    if (p.type === 'rain') {
      root.appendChild(slider('Drops', p.drops, { min: 1, max: 24, step: 1 },
        this.live(`${layer.id}:pdrops`, 'drops', (v) => { p.drops = Math.round(v); })));
      root.appendChild(field('Fall time (ms)', numberInput(p.dropMs, 100, 60000, 50,
        (v) => edit('fall time', () => {
          p.dropMs = Math.max(100, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(slider('Trail length', p.tailLen, { min: 0.02, max: 0.8, step: 0.02 },
        this.live(`${layer.id}:prtail`, 'trail', (v) => { p.tailLen = v; })));
      root.appendChild(field('Seed', numberInput(p.seed, 1, 9999, 1,
        (v) => edit('seed', () => { p.seed = Math.round(v); this.buildLayer(); }))));
      root.appendChild(hint('Each drop keeps its column and its place in the cycle, picked '
        + 'from the seed, so the same show always rains the same way. Change the seed for '
        + 'a different arrangement.'));
    }

    if (p.type === 'plasma') {
      root.appendChild(field('Second colour', colorInput(p.color2,
        this.live(`${layer.id}:ppc2`, 'colour', (v) => { p.color2 = v; }))));
      root.appendChild(slider('Detail', p.plasmaScale, { min: 0.5, max: 6, step: 0.1 },
        this.live(`${layer.id}:pps`, 'detail', (v) => { p.plasmaScale = v; })));
      root.appendChild(field('Cycle (ms)', numberInput(p.plasmaMs, 200, 60000, 100,
        (v) => edit('plasma cycle', () => {
          p.plasmaMs = Math.max(200, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(hint('Three overlapping sine fields across the real light positions. '
        + 'Every light gets its own colour and brightness, which is the sort of thing that '
        + 'is hopeless to write by hand.'));
    }

    if (p.type === 'contagion') {
      root.appendChild(field('Starts at', selectBox(p.spreadFrom, [
        ['centre', 'The middle'], ['bottom', 'The bottom'], ['top', 'The top'],
        ['left', 'The left'], ['right', 'The right'],
      ], (v) => edit('spread from', () => { p.spreadFrom = v; this.buildLayer(); }))));
      root.appendChild(field('Spread time (ms)', numberInput(p.spreadMs, 100, 60000, 50,
        (v) => edit('spread time', () => {
          p.spreadMs = Math.max(100, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(slider('Reach', p.spreadRadius, { min: 0.04, max: 0.6, step: 0.01 },
        this.live(`${layer.id}:psr`, 'reach', (v) => { p.spreadRadius = v; })));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Lit stays lit', p.spreadHold !== false, (v) => edit('spread hold', () => {
          p.spreadHold = v;
          this.buildLayer();
        })),
      ]));
      if (p.spreadHold === false) {
        root.appendChild(slider('Front width', p.spreadTrail, { min: 0.05, max: 3, step: 0.05 },
          this.live(`${layer.id}:pst`, 'front width', (v) => { p.spreadTrail = v; })));
      }
      root.appendChild(hint('Light spreads from one light to its neighbours, then theirs, '
        + 'so it follows the shape of your playfield - up a ramp, round an orbit - rather '
        + 'than a straight line. Reach decides how close counts as a neighbour: too small '
        + 'and the spread cannot cross gaps, too large and it jumps everywhere at once.'));
    }

    if (p.type === 'comet') {
      root.appendChild(slider('Comets', p.comets, { min: 1, max: 8, step: 1 },
        this.live(`${layer.id}:pcn`, 'comets', (v) => { p.comets = Math.round(v); })));
      root.appendChild(field('Throw time (ms)', numberInput(p.cometMs, 200, 60000, 50,
        (v) => edit('throw time', () => {
          p.cometMs = Math.max(200, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(slider('Launch speed', p.launchSpeed, { min: 0.3, max: 4, step: 0.05 },
        this.live(`${layer.id}:pls`, 'launch speed', (v) => { p.launchSpeed = v; })));
      root.appendChild(slider('Gravity', p.gravity, { min: 0, max: 12, step: 0.1 },
        this.live(`${layer.id}:pg`, 'gravity', (v) => {
          const wasOff = (p.gravity || 0) <= 0.001;
          p.gravity = v;
          // the two modes offer different controls, so rebuild when it crosses
          if (wasOff !== (v <= 0.001)) this.buildLayer();
        })));
      if ((p.gravity || 0) <= 0.001) {
        root.appendChild(slider('Angle', p.cometAngle == null ? 35 : p.cometAngle,
          { min: 5, max: 85, step: 1 },
          this.live(`${layer.id}:pca`, 'angle', (v) => { p.cometAngle = v; })));
        root.appendChild(hint('Gravity 0 is the DVD-logo bounce: a straight line at a '
          + 'constant speed, reflecting off all four edges. Angle sets how steep the '
          + 'path is - 45 makes clean diagonals, near 0 or 90 skims an edge.'));
      } else {
        root.appendChild(slider('Bounciness', p.bounceDamp, { min: 0.05, max: 0.95, step: 0.01 },
          this.live(`${layer.id}:pbd`, 'bounciness', (v) => { p.bounceDamp = v; })));
        root.appendChild(hint('With gravity it is a thrown ball: it arcs up, falls, and '
          + 'bounces off the floor, losing height each time. Drop gravity to 0 for a '
          + 'straight-line bounce off all four edges instead.'));
      }
      root.appendChild(slider('Size', p.cometWidth, { min: 0.02, max: 0.4, step: 0.01 },
        this.live(`${layer.id}:pcw`, 'size', (v) => { p.cometWidth = v; })));
      root.appendChild(slider('Trail', p.cometTrail, { min: 0, max: 0.8, step: 0.02 },
        this.live(`${layer.id}:pct`, 'trail', (v) => { p.cometTrail = v; })));
      root.appendChild(field('Seed', numberInput(p.seed, 1, 9999, 1,
        (v) => edit('seed', () => { p.seed = Math.round(v); this.buildLayer(); }))));
      root.appendChild(hint('Worked out from the time directly rather than stepped frame '
        + 'to frame, so it replays identically and the export matches the preview.'));
    }

    if (p.type === 'sweep') {
      // Offer the groups worth sweeping first. The raw tag order puts the
      // broadest tags at the top - on one machine that is `strip` (300 lights)
      // followed by four 150-light subsets of it - so picking the first few
      // lights nearly the same lights every slot and the sweep looks static.
      // Rank by how much of a group is its own rather than shared.
      const lights = app.lights || [];
      const members = new Map();
      for (const tg of (app.tags || [])) {
        if (tg.tag === 'all') continue;
        members.set(tg.tag, lights.filter((l) => (l.tags || []).includes(tg.tag)));
      }
      const share = new Map();      // light name -> how many groups claim it
      for (const set of members.values()) {
        for (const l of set) share.set(l.name, (share.get(l.name) || 0) + 1);
      }
      const known = [...members.keys()].sort((x, y) => {
        const score = (tg) => {
          const set = members.get(tg);
          if (!set.length) return -1;
          // average exclusivity, penalising groups that cover almost everything
          const own = set.reduce((n, l) => n + 1 / (share.get(l.name) || 1), 0) / set.length;
          const size = set.length / Math.max(1, lights.length);
          return own * (size > 0.5 ? 0.3 : 1);
        };
        return score(y) - score(x);
      });
      const box = el('input', {
        type: 'text', value: (p.tagOrder || []).join(', '),
        placeholder: 'e.g. left_ramp, centre, right_orbit',
        title: 'Tag names in the order they should light',
      });
      box.addEventListener('change', () => edit('tag order', () => {
        p.tagOrder = String(box.value).split(/[,\s]+/).filter(Boolean);
        this.buildLayer();
      }));
      root.appendChild(field('Order', box));
      if (p.fit !== false) {
        const n = Math.max(1, (p.tagOrder || []).length);
        root.appendChild(hint('Fit to layer length is on, so the dwell comes from the '
          + `clip: ${n} group${n === 1 ? '' : 's'} over its ${layer.durationMs} ms, `
          + `about ${Math.round(layer.durationMs / n)} ms each. Turn Fit off to set the `
          + 'dwell directly.'));
      } else
      root.appendChild(field('Dwell (ms)', numberInput(p.dwellMs, 20, 30000, 10,
        (v) => edit('dwell', () => {
          p.dwellMs = Math.max(20, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(slider('Hand-over', p.crossfade, { min: 0, max: 0.9, step: 0.05 },
        this.live(`${layer.id}:pcf`, 'hand-over', (v) => { p.crossfade = v; })));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Groups stay lit', !!p.sweepHold, (v) => edit('sweep hold', () => {
          p.sweepHold = v;
          this.buildLayer();
        })),
      ]));
      if (!(p.tagOrder || []).length) {
        root.appendChild(hint('No groups yet, so this layer lights nothing. Type tag names '
          + 'above, separated by commas, in the order you want them to fire.'));
      }
      if (known.length) {
        const chosen = p.tagOrder || [];
        root.appendChild(el('div', { class: 'btn-row' },
          known.slice(0, 14).map((tg) => {
            const at = chosen.indexOf(tg);
            const on = at >= 0;
            // Toggle, not append: changing your mind about a group meant
            // retyping the list, and nothing showed which were already in it.
            const b = button(on ? `${at + 1}. ${tg}` : tg, () => edit('toggle group', () => {
              const next = (p.tagOrder || []).slice();
              const i = next.indexOf(tg);
              if (i >= 0) next.splice(i, 1); else next.push(tg);
              p.tagOrder = next;
              this.buildLayer();
            }), 'small' + (on ? ' on' : ''));
            b.title = on
              ? `Group ${at + 1} of ${chosen.length} - click to remove`
              : `${(members.get(tg) || []).length} lights - click to add`;
            return b;
          })));
        root.appendChild(hint('Click a tag to add it, click it again to take it out. '
          + 'The number is its place in the order. Groups fire one after another, which '
          + 'reads far more clearly on a scattered playfield than a single travelling dot.'
          + (chosen.length ? '' : ' Groups nearest the top of this list overlap least, '
            + 'so they read most clearly.')));
      }
    }

    if (p.type === 'interference') {
      root.appendChild(field('Travels', selectBox(p.axis, [
        ['radial', 'Out from the centre'],
        ['y', 'Up the playfield'], ['x', 'Across the playfield'],
      ], (v) => edit('axis', () => { p.axis = v; this.buildLayer(); }))));
      root.appendChild(slider('First wavelength', p.wavelength, { min: 0.05, max: 2, step: 0.01 },
        this.live(`${layer.id}:piw1`, 'wavelength', (v) => { p.wavelength = v; })));
      root.appendChild(slider('Second wavelength', p.wavelength2, { min: 0.05, max: 2, step: 0.01 },
        this.live(`${layer.id}:piw2`, 'wavelength', (v) => { p.wavelength2 = v; })));
      root.appendChild(field('Cycle (ms)', numberInput(p.periodMs, 50, 60000, 50,
        (v) => edit('cycle', () => {
          p.periodMs = Math.max(50, Math.round(v));
          this.buildLayer();
        }))));
      const beat = Math.abs(p.wavelength - p.wavelength2) < 0.001 ? null
        : Math.abs(1 / (1 / p.wavelength - 1 / p.wavelength2));
      root.appendChild(hint('Two waves multiplied. Close wavelengths give a slow travelling '
        + 'beat; identical ones give one plain wave.'
        + (beat ? ` These beat every ${beat.toFixed(2)} of the group.` : '')));
    }

    if (p.type === 'voronoi') {
      root.appendChild(slider('Territories', p.seeds, { min: 2, max: 10, step: 1 },
        this.live(`${layer.id}:pvs`, 'territories', (v) => { p.seeds = Math.round(v); })));
      root.appendChild(field('Drift time (ms)', numberInput(p.voronoiMs, 500, 120000, 100,
        (v) => edit('drift time', () => {
          p.voronoiMs = Math.max(500, Math.round(v));
          this.buildLayer();
        }))));
      root.appendChild(slider('Drift distance', p.voronoiDrift, { min: 0, max: 0.6, step: 0.01 },
        this.live(`${layer.id}:pvd`, 'drift', (v) => { p.voronoiDrift = v; })));
      root.appendChild(field('Seed', numberInput(p.seed, 1, 9999, 1,
        (v) => edit('seed', () => { p.seed = Math.round(v); this.buildLayer(); }))));
      root.appendChild(hint('Each territory owns the lights nearest to it and drifts, so '
        + 'lights change colour as the boundaries sweep over them. Uses the sparkle '
        + 'palette below for its colours.'));
      root.appendChild(this.buildPalette(layer, edit));
    }

    if (p.type === 'blink' || p.type === 'solid') {
      root.appendChild(section('Pulse'));
      root.appendChild(field('Shape', selectBox(p.pulseShape || 'steady', [
        ['steady', 'Steady (no pulse)'],
        ['breathe', 'Breathe (quick in, slow out)'],
        ['heartbeat', 'Heartbeat (lub-dub, then a rest)'],
        ['triangle', 'Up and down'],
        ['ramp-up', 'Ramp up'],
        ['ramp-down', 'Ramp down'],
      ], (v) => edit('pulse shape', () => { p.pulseShape = v; this.buildLayer(); }))));
      if ((p.pulseShape || 'steady') !== 'steady') {
        root.appendChild(field('Pulse (ms)', numberInput(p.pulseMs, 100, 60000, 50,
          (v) => edit('pulse time', () => {
            p.pulseMs = Math.max(100, Math.round(v));
            this.buildLayer();
          }))));
        root.appendChild(slider('Depth', p.pulseDepth == null ? 1 : p.pulseDepth,
          { min: 0, max: 1, step: 0.05 },
          this.live(`${layer.id}:ppd`, 'depth', (v) => { p.pulseDepth = v; })));
        root.appendChild(hint('Shapes the brightness over the whole layer. A plain fade is '
          + 'what keyframes are for; these are the curves that are tedious to keyframe. '
          + 'Depth 1 dips to black, lower keeps a floor.'));
      }
    }

    if (p.type === 'blink') {
      root.appendChild(field('On (ms)', numberInput(p.onMs, 1, 60000, 10,
        (v) => edit('on time', () => { p.onMs = Math.max(1, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(field('Off (ms)', numberInput(p.offMs, 0, 60000, 10,
        (v) => edit('off time', () => { p.offMs = Math.max(0, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(field('When off', selectBox(p.offMode, [
        ['dark', 'Dark'], ['colour', 'A second colour'],
      ], (v) => edit('off mode', () => { p.offMode = v; this.buildLayer(); }))));
      if (p.offMode === 'colour') {
        root.appendChild(field('Off colour', colorInput(p.offColor,
          this.live(`${layer.id}:poff`, 'off colour', (v) => { p.offColor = v; }))));
      }
      const period = Math.max(1, p.onMs + p.offMs);
      root.appendChild(hint(`${(1000 / period).toFixed(2)} blinks per second; `
        + `${Math.floor(layer.durationMs * Math.max(1, layer.repeat || 1) / period)} `
        + 'over this clip.'));
      for (const [v, what] of [[p.onMs, 'On'], [p.offMs, 'Off']]) {
        const h = v > 0 && this.quantiseHint(v, app.project.fps, what);
        if (h) root.appendChild(h);
      }
    }

    if (p.type === 'chase') {
      if (p.fit !== false) {
        root.appendChild(hint('Fit to layer length is on, so the step time comes '
          + 'from the clip: one full pass along the lights over its '
          + `${layer.durationMs} ms. Turn Fit off to set the step directly.`));
      } else
      root.appendChild(field('Step (ms)', numberInput(p.stepMs, 1, 10000, 10,
        (v) => edit('chase step', () => { p.stepMs = Math.max(1, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(slider('Lit at once', p.width, { min: 1, max: 12, step: 1 },
        this.live(`${layer.id}:pwidth`, 'chase width', (v) => { p.width = Math.round(v); })));
      root.appendChild(slider('Fading tail', p.tail, { min: 0, max: 12, step: 1 },
        this.live(`${layer.id}:ptail`, 'chase tail', (v) => { p.tail = Math.round(v); })));
      root.appendChild(field('Order by', selectBox(p.order, [
        ['name', 'Light name (natural)'],
        ['y', 'Top to bottom'],
        ['x', 'Left to right'],
        ['angle', 'Around the centre'],
      ], (v) => edit('chase order', () => { p.order = v; this.buildLayer(); }))));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Reverse', p.reverse, (v) => edit('reverse', () => { p.reverse = v; this.buildLayer(); })),
      ]));
      if (count) {
        const cycle = count * Math.max(1, p.stepMs);
        root.appendChild(hint(`${count} lights, so one full pass takes ${cycle} ms.`));
        const order = orderedTargets(layer, app.lights, layerMask(layer, app.lights));
        root.appendChild(hint('Order: ' + order.slice(0, 5).map((i) => app.lights[i].name).join(' -> ')
          + (order.length > 5 ? ' -> ...' : '')));
      }
      const h = this.quantiseHint(p.stepMs, app.project.fps, 'Step');
      if (h) root.appendChild(h);
    }

    root.appendChild(section('Blend'));
    root.appendChild(field('Mode', selectBox(layer.blend, [
      ['add', 'Add (stacks with other layers)'],
      ['normal', 'Normal (overrides what is under it)'],
      ['average', 'Average (blends colours)'],
      ['erase', 'Erase (turns lights off)'],
    ], (v) => edit('blend', () => { layer.blend = v; this.buildLayer(); }))));
    if (layer.blend === 'erase') {
      root.appendChild(hint('Erase does not light anything. Wherever it covers a light it switches '
        + 'that light off, so it only affects layers below it in the list. Use it '
        + 'to punch a moving hole in something, or to hold a group dark while the '
        + 'rest of the show runs.'));
    }
    if (layer.blend === 'average') {
      root.appendChild(hint('Every averaging layer reaching a light is mixed into one colour '
        + 'rather than added, so red over blue gives purple instead of magenta-white. '
        + 'The result is scaled back up to the brightest layer that reached it, so '
        + 'mixing does not dim the light. Averaging layers mix with each other; '
        + 'anything on Add still stacks on top.'));
    }

    root.appendChild(section('Timing'));
    root.appendChild(field('Start (ms)', numberInput(layer.startMs, 0, 600000, 10,
      (v) => edit('start', () => { layer.startMs = Math.max(0, Math.round(v)); }))));
    root.appendChild(field('Length (ms)', numberInput(layer.durationMs, 16, 600000, 10,
      (v) => edit('length', () => { layer.durationMs = Math.max(16, Math.round(v)); this.buildLayer(); }))));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Visible after', layer.holdAfter, (v) => edit('hold', () => { layer.holdAfter = v; })),
    ]));

    root.appendChild(hint(count
      ? `Drives ${count} light${count === 1 ? '' : 's'} at exact colours - no shape to `
        + 'position and no pixel sampling, so the values land precisely as set.'
      : 'No lights selected yet. Pick some tags on the Lights tab.'));
    root.appendChild(hint('Pattern layers draw nothing on the playfield, so switch the '
      + 'view to Lights or Both to see them.'));
  }

  /** Editable colour list for the sparkle palette. */
  buildPalette(layer, edit) {
    const p = layer.pattern;
    const wrap = el('div', { class: 'chips' });
    p.colors.forEach((c, i) => {
      const sw = el('input', { type: 'color', value: c });
      const onPick = this.live(`${layer.id}:pal${i}`, 'palette', (v) => { p.colors[i] = v; });
      sw.addEventListener('input', () => onPick(sw.value));
      const cell = el('span', { class: 'pal' }, [sw]);
      if (p.colors.length > 1) {
        cell.appendChild(el('button', { class: 'pal-x', text: '\u00d7', title: 'Remove',
          onclick: () => edit('remove colour', () => {
            p.colors.splice(i, 1); this.buildLayer();
          }) }));
      }
      wrap.appendChild(cell);
    });
    wrap.appendChild(el('button', { class: 'chip', text: '+ colour',
      onclick: () => edit('add colour', () => {
        p.colors.push('#ffffff'); this.buildLayer();
      }) }));
    return wrap;
  }

  /** Panel for a layer that replays an imported MPF show. */
  buildShowLayer(root, layer, edit) {
    const app = this.app;
    const show = layer.show || {};
    const cov = showCoverage(layer, app.lights);

    root.appendChild(section('Imported show'));
    root.appendChild(el('div', { class: 'stat-grid' }, [
      el('span', { text: 'File' }), el('span', { text: show.name || '-' }),
      el('span', { text: 'Frames' }), el('span', { text: String(show.frames || 0) }),
      el('span', { text: 'Lights' }), el('span', { text: String((show.lightNames || []).length) }),
      el('span', { text: 'Authored for' }), el('span', { text: show.sourceMap || 'unknown map' }),
    ]));

    root.appendChild(section('Against the current map'));
    if (cov) {
      root.appendChild(el('div', { class: 'stat-grid' }, [
        el('span', { text: 'By name' }), el('span', { text: String(cov.byName) }),
        el('span', { text: 'By position' }), el('span', { text: String(cov.byPosition) }),
        el('span', { text: 'Unmatched' }), el('span', { text: String(cov.unmatched) }),
      ]));
      if (cov.unmatched) {
        root.appendChild(hint('Not in this light map: ' + cov.missing.slice(0, 8).join(', ')
          + (cov.missing.length > 8 ? ` and ${cov.missing.length - 8} more` : '')));
      }
    }
    root.appendChild(field('If a name is gone', selectBox(layer.remap || 'name', [
      ['name', 'Leave it unlit'],
      ['nearest', 'Use the nearest light to where it was'],
    ], (v) => edit('remap', () => { layer.remap = v; this.buildLayer(); }))));
    root.appendChild(hint('Shows are stored by light name, so lights that merely moved '
      + 'keep working. This only affects names that no longer exist.'));

    root.appendChild(section('Playback'));
    root.appendChild(field('Blend', selectBox(layer.blend, [
      ['add', 'Add (stacks with other layers)'], ['normal', 'Normal (overrides)'],
      ['average', 'Average (blends colours)'],
      ['erase', 'Erase (turns lights off)'],
    ], (v) => edit('blend', () => { layer.blend = v; this.buildLayer(); }))));
    if (layer.blend === 'erase') {
      root.appendChild(hint('Erase does not light anything. Wherever it covers a light it switches '
        + 'that light off, so it only affects layers below it in the list. Use it '
        + 'to punch a moving hole in something, or to hold a group dark while the '
        + 'rest of the show runs.'));
    }
    if (layer.blend === 'average') {
      root.appendChild(hint('Every averaging layer reaching a light is mixed into one colour '
        + 'rather than added, so red over blue gives purple instead of magenta-white. '
        + 'The result is scaled back up to the brightest layer that reached it, so '
        + 'mixing does not dim the light. Averaging layers mix with each other; '
        + 'anything on Add still stacks on top.'));
    }
    root.appendChild(field('Start (ms)', numberInput(layer.startMs, 0, 600000, 1,
      (v) => edit('start', () => { layer.startMs = v; }))));
    root.appendChild(field('Length (ms)', numberInput(layer.durationMs, 16, 600000, 1,
      (v) => edit('length', () => { layer.durationMs = Math.max(16, v); }))));
    root.appendChild(hint('Stretching the clip resamples the show, so it can run '
      + 'faster or slower than it was authored.'));
    root.appendChild(field('Repeat', numberInput(layer.repeat || 1, 1, 200, 1,
      (v) => edit('repeat', () => { layer.repeat = Math.max(1, Math.round(v)); }))));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Ping-pong', layer.pingpong, (v) => edit('pingpong', () => { layer.pingpong = v; })),
      checkbox('Hold after', layer.holdAfter, (v) => edit('hold', () => { layer.holdAfter = v; })),
    ]));
    root.appendChild(hint('Brightness comes from the keyframes on the Keyframe tab - '
      + 'set the first or last to 0 to fade the whole show in or out.'));
  }

  // ------------------------------------------------------------ keyframe

  buildKey() {
    const app = this.app;
    const root = clear(this.panels.key);
    const layer = app.selectedLayer();
    if (!layer) {
      root.appendChild(el('div', { class: 'empty', text: 'No layer selected.' }));
      return;
    }
    const idx = Math.max(0, Math.min(layer.keys.length - 1, app.selectedKeyIndex));
    const k = layer.keys[idx];
    if (!k) {
      root.appendChild(el('div', { class: 'empty', text: 'No keyframe selected.' }));
      return;
    }
    const edit = (label, fn) => { app.pushUndo(label); fn(); app.onProjectEdit({}); };
    const kk = (field) => `${layer.id}:k${idx}:${field}`;

    root.appendChild(section(`Keyframe ${idx + 1} of ${layer.keys.length}`));

    const nav = el('div', { class: 'btn-row' }, [
      button('◀ Prev', () => { app.selectKey(idx - 1); app.refreshInspector(); app.requestDraw(); }, 'small'),
      button('Next ▶', () => { app.selectKey(idx + 1); app.refreshInspector(); app.requestDraw(); }, 'small'),
      button('Go to', () => app.setTime(layer.startMs + k.t * layer.durationMs), 'small'),
    ]);
    root.appendChild(nav);

    root.appendChild(slider('Position in clip', k.t, { min: 0, max: 1, step: 0.001 },
      this.live(kk('t'), 'move keyframe', (v) => { k.t = v; invalidateKeys(layer); })));
    root.appendChild(hint(`= ${Math.round(layer.startMs + k.t * layer.durationMs)} ms on the show timeline`));

    root.appendChild(section('Transform'));
    root.appendChild(slider('X', k.x, { min: 0, max: 1, step: 0.001 },
      this.live(kk('x'), 'move', (v) => { k.x = v; })));
    root.appendChild(slider('Y', k.y, { min: 0, max: 1, step: 0.001 },
      this.live(kk('y'), 'move', (v) => { k.y = v; })));
    root.appendChild(slider('Rotation', k.rot, { min: -1080, max: 1080, step: 1 },
      this.live(kk('rot'), 'rotate', (v) => { k.rot = v; })));
    root.appendChild(slider('Scale X', k.sx, { min: 0.005, max: 3, step: 0.005 },
      this.live(kk('sx'), 'scale', (v) => { k.sx = v; })));
    root.appendChild(slider('Scale Y', k.sy, { min: 0.005, max: 3, step: 0.005 },
      this.live(kk('sy'), 'scale', (v) => { k.sy = v; })));
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Link scales', () => edit('link scale', () => {
        k.sy = k.sx; this.buildKey();
      }), 'small'),
      button('Centre', () => edit('centre', () => { k.x = 0.5; k.y = 0.5; this.buildKey(); }), 'small'),
    ]));
    root.appendChild(el('div', { class: 'btn-row' },
      SIZE_PRESETS.map((sz) => button(sz.label, () => edit('size ' + sz.label, () => {
        applySize(layer, sz.scale, false, k);
        this.buildKey();
      }), 'small'))));

    root.appendChild(section('Colour & fade'));
    root.appendChild(field('Colour', colorInput(k.color,
      this.live(kk('color'), 'colour', (v) => { k.color = v; app.rebuildHeads(); }))));
    if (layer.colorMode === 'gradient') {
      root.appendChild(field('Colour 2', colorInput(k.color2 || k.color,
        this.live(kk('color2'), 'colour', (v) => { k.color2 = v; }))));
    }
    root.appendChild(slider('Brightness', k.alpha, { min: 0, max: 1, step: 0.01 },
      this.live(kk('alpha'), 'brightness', (v) => { k.alpha = v; })));

    root.appendChild(section('Easing to next key'));
    root.appendChild(field('Curve', selectBox(k.ease, EASE_NAMES, (v) => edit('ease', () => { k.ease = v; }))));
    root.appendChild(hint('"hold" freezes this keyframe until the next one — good for hard blinks.'));

    root.appendChild(section('Actions'));
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Copy', () => { app.keyClipboard = Object.assign({}, k); }, 'small'),
      button('Paste', () => edit('paste key', () => {
        if (!app.keyClipboard) return;
        Object.assign(k, app.keyClipboard, { t: k.t });
        this.buildKey();
      }), 'small'),
      button('Duplicate', () => edit('duplicate key', () => {
        const t = Math.min(1, k.t + 0.05);
        layer.keys.push(makeKey(t, Object.assign({}, k, { t })));
        layer.keys.sort((a, b) => a.t - b.t);
        invalidateKeys(layer);
        this.app.refreshInspector();
      }), 'small'),
      button('Delete', () => edit('delete key', () => {
        if (layer.keys.length <= 1) return;
        layer.keys.splice(idx, 1);
        invalidateKeys(layer);
        app.selectKey(Math.max(0, idx - 1));
        this.app.refreshInspector();
      }), 'small danger'),
    ]));
  }

  // ------------------------------------------------------------ show

  buildShow() {
    const app = this.app;
    const root = clear(this.panels.show);
    const p = app.project;
    const edit = (label, fn) => { app.pushUndo(label); fn(); app.onProjectEdit({}); };

    const effective = Math.round(projectDuration(p));

    root.appendChild(section('Show length'));
    root.appendChild(field('Length (ms)', numberInput(p.durationMs, 0, 600000, 1,
      (v) => edit('duration', () => { p.durationMs = Math.max(0, Math.round(v)); this.buildShow(); }))));
    root.appendChild(hint(p.durationMs > 0
      ? `Fixed at ${effective} ms (${(effective / 1000).toFixed(2)} s). Set to 0 to follow the layers.`
      : `Following the layers: ${effective} ms (${(effective / 1000).toFixed(2)} s).`));

    const target = el('input', { type: 'number', value: effective, min: 50, max: 600000, step: 10 });
    const fit = el('div', { class: 'field row' }, [
      el('label', { text: 'Fit to' }),
      el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
        target,
        button('Scale', () => {
          const v = Number(target.value);
          if (v > 0) app.scaleShowToLength(v);
        }, 'small'),
      ]),
    ]);
    root.appendChild(fit);
    root.appendChild(hint('Stretches or squeezes every layer so the whole show runs '
      + 'for that long, keeping the composition intact.'));

    root.appendChild(section('Sample rate'));
    root.appendChild(slider('Rate (Hz)', p.fps, { min: 10, max: 60, step: 1 },
      this.live('show:fps', 'sample rate', (v) => { p.fps = Math.round(v); })));
    root.appendChild(el('div', { class: 'stat-grid' }, [
      el('span', { text: 'Steps' }), el('span', { text: `up to ${frameCount(p)}` }),
      el('span', { text: 'Step length' }), el('span', { text: `${(1000 / p.fps).toFixed(1)} ms` }),
    ]));
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Measure cost of each rate...', () => app.analyseRates(), 'small'),
    ]));
    root.appendChild(hint('The rate only controls smoothness and file size - step '
      + 'durations are written into the show, so the playback speed is the same '
      + 'either way. 30 Hz suits most shows; raise it for fast blinks, which can '
      + 'vanish entirely if the rate is too low.'));

    root.appendChild(section('Playfield'));
    root.appendChild(field('Body', selectBox(String(p.aspect), [
      ['0.5', 'Original tool (350×700)'],
      ['0.482', 'Standard (20.25″ × 42″)'],
      ['0.554', 'Widebody (23.25″ × 42″)'],
    ], (v) => edit('aspect', () => { p.aspect = Number(v); app.onAspectChange(); }))));

    root.appendChild(section('Light map'));
    root.appendChild(el('div', { class: 'stat-grid' }, [
      el('span', { text: 'Positions' }), el('span', { text: p.lightMap || '-' }),
      el('span', { text: 'Tags' }), el('span', { text: p.tagFile || 'none' }),
      el('span', { text: 'Lights' }), el('span', { text: String(app.lights.length) }),
      el('span', { text: 'Tags found' }), el('span', { text: String(app.tags.length) }),
    ]));
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Import monitor.yaml...', () => app.importLightMap(), 'small'),
      button('Import lights.yaml...', () => app.importTagFile(), 'small'),
    ]));
    root.appendChild(hint('Both choices are remembered and reloaded next time you open the app.'));

    root.appendChild(section('Playfield image'));
    const bg = p.background;
    if (bg) {
      root.appendChild(el('div', { class: 'stat-grid' }, [
        el('span', { text: 'File' }), el('span', { text: bg.name }),
      ]));
      root.appendChild(slider('Opacity', bg.opacity == null ? 0.5 : bg.opacity,
        { min: 0, max: 1, step: 0.01 },
        this.live('bg:opacity', 'image opacity', (v) => { bg.opacity = v; })));
      root.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Visible', bg.visible !== false, (v) => {
          app.pushUndo('image visibility'); bg.visible = v; app.requestDraw();
        }),
        button('Replace...', () => app.importBackground(), 'small'),
        button('Remove', () => app.setBackground(null), 'small danger'),
      ]));
    } else {
      root.appendChild(el('div', { class: 'btn-row' }, [
        button('Add a playfield image...', () => app.importBackground(), 'small'),
      ]));
    }
    root.appendChild(hint('A photo or render of the playfield to aim effects against. '
      + 'It is a tracing guide only and never affects exported colours.'));

    root.appendChild(section('Layers'));
    root.appendChild(el('div', { class: 'stat-grid' }, [
      el('span', { text: 'Count' }), el('span', { text: String(p.layers.length) }),
      el('span', { text: 'Frames' }), el('span', { text: String(frameCount(p)) }),
    ]));
  }

  // ------------------------------------------------------------ export

  /**
   * A collapsible block, for settings that are chosen once and then ignored.
   *
   * Open state is remembered per key for the session, so someone doing work in
   * there is not made to reopen it every time the panel rebuilds - which it
   * does on every edit.
   */
  fold(parent, key, label) {
    this.foldOpen = this.foldOpen || {};
    const open = !!this.foldOpen[key];
    const box = el('div', { class: 'fold-body' + (open ? '' : ' hidden') });
    const arrow = el('span', { class: 'wiz-adv-arrow', text: open ? '\u25be' : '\u25b8' });
    const toggle = el('button', {
      class: 'wiz-adv' + (open ? ' on' : ''),
      onclick: () => {
        const now = !this.foldOpen[key];
        this.foldOpen[key] = now;
        box.classList.toggle('hidden', !now);
        toggle.classList.toggle('on', now);
        arrow.textContent = now ? '\u25be' : '\u25b8';
      },
    }, [arrow, el('span', { text: label })]);
    parent.appendChild(toggle);
    parent.appendChild(box);
    return box;
  }

  buildExport() {
    const app = this.app;
    const root = clear(this.panels.export);
    const p = app.project;
    const x = p.export;
    const edit = (label, fn) => { app.pushUndo(label); fn(); app.onProjectEdit({}); };

    root.appendChild(section('MPF version'));
    root.appendChild(field('Write for', selectBox(x.mpfTarget || '0.80', [
      ['0.80', 'MPF 0.57 and newer'],
      ['0.50', 'MPF 0.50 - 0.56 (legacy)'],
    ], (v) => edit('mpf target', () => { x.mpfTarget = v; this.buildExport(); }))));
    root.appendChild(hint((x.mpfTarget || '0.80') === '0.50'
      ? 'Writes #show_version=5 and relative "time: +1" steps, like the original '
        + 'tool. MPF 0.57+ refuses to load this header, and "+1" means one SECOND, '
        + 'so the show only runs at the right rate when played with speed set to '
        + 'the frame rate.'
      : 'Writes #show_version=6 and an explicit "duration: 33ms" on every step, so '
        + 'the show plays at the correct rate at the default speed.'));

    // Where the show goes and the button that writes it are what this panel
    // is for. Blending, sampling and YAML output shape the file once per
    // machine and are then left alone, so they sit behind a fold instead of
    // filling the panel above the thing you actually came here to press.
    const adv = this.fold(root, 'export', 'Output settings');
    adv.appendChild(section('Blending'));
    adv.appendChild(field('Layers add in', selectBox(x.blend || 'linear', [
      ['linear', 'Linear light (physical)'],
      ['srgb', 'sRGB (original tool)'],
    ], (v) => edit('blend', () => { x.blend = v; this.buildExport(); }))));
    adv.appendChild(hint(x.blend === 'srgb'
      ? 'Adds the encoded 8-bit values, like the original tool did. Overlaps come '
        + 'out brighter than the hardware will actually produce.'
      : 'Converts to linear light before adding, which is how real LEDs combine. '
        + 'Overlapping layers land where the machine will put them.'));

    adv.appendChild(section('Sampling'));
    adv.appendChild(field('Colour', selectBox(x.mode, [
      ['colour', 'Full colour'],
      ['threshold', 'Cut dark values'],
      ['bw', 'Black & white'],
    ], (v) => edit('mode', () => { x.mode = v; this.buildExport(); }))));
    if (x.mode !== 'colour') {
      adv.appendChild(slider('Threshold', x.threshold, { min: 1, max: 254, step: 1 },
        this.live('export:threshold', 'threshold', (v) => { x.threshold = v; })));
    }
    adv.appendChild(slider('Sample radius (px)', x.sampleRadius, { min: 0, max: 8, step: 1 },
      this.live('export:sampleRadius', 'sample radius', (v) => { x.sampleRadius = v; })));
    adv.appendChild(hint('0 samples a single pixel like the original tool. 2–3 gives smoother, less jittery output.'));
    adv.appendChild(slider('Gamma', x.gamma, { min: 0.3, max: 3, step: 0.05 },
      this.live('export:gamma', 'gamma', (v) => { x.gamma = v; })));
    adv.appendChild(slider('Minimum lit level', x.minLevel, { min: 0, max: 128, step: 1 },
      this.live('export:minLevel', 'minimum level', (v) => { x.minLevel = v; })));
    adv.appendChild(hint('Lifts dim pixels so faint edges still light an LED.'));

    adv.appendChild(section('YAML output'));
    adv.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Only changed lights per step', x.diffOnly !== false,
        (v) => edit('diff', () => { x.diffOnly = v; })),
    ]));
    adv.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Write "stop" for black', !!x.blackAsStop,
        (v) => edit('stop', () => { x.blackAsStop = v; })),
    ]));
    adv.appendChild(field('Fade (ms)', numberInput(x.fadeMs || 0, 0, 5000, 1,
      (v) => edit('fade', () => { x.fadeMs = Math.max(0, Math.round(v)); }))));
    adv.appendChild(hint('0 = no fade key, matching the original output.'));

    adv.appendChild(section('Dead frames'));
    adv.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Trim dark frames at the start', x.trimStart === true,
        (v) => edit('trim start', () => { x.trimStart = v; this.buildExport(); })),
    ]));
    adv.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Trim dark frames at the end', x.trimEnd !== false,
        (v) => edit('trim end', () => { x.trimEnd = v; this.buildExport(); })),
    ]));
    adv.appendChild(hint(x.trimStart
      ? 'Trimming the start shifts every cue earlier by however much silence is '
        + 'removed. Leave it off for a show cut to audio or video.'
      : 'Leading silence is kept, so the show stays in sync with whatever you '
        + 'timed it against.'));
    adv.appendChild(field('Idle steps', selectBox(x.idleMode || 'hold', [
      ['hold', 'Restate previous colours'],
      ['collapse', 'Merge into the next step (+N)'],
      ['bare', 'Time-only step (original tool)'],
    ], (v) => edit('idle mode', () => { x.idleMode = v; this.buildExport(); }))));
    adv.appendChild(hint(x.idleMode === 'bare'
      ? 'The original tool wrote steps containing only a time. Your hand-finished shows have none of these — the other two options avoid them.'
      : 'Steps where nothing changes still need to consume time. This keeps every step valid YAML with real content.'));

    root.appendChild(section('Where it goes'));
    root.appendChild(this.buildDestinationUI());

    root.appendChild(section('Generate'));
    root.appendChild(el('div', { class: 'stat-grid' }, [
      el('span', { text: 'Steps' }), el('span', { text: String(frameCount(p)) }),
      el('span', { text: 'Length' }), el('span', { text: Math.round(projectDuration(p)) + ' ms' }),
      el('span', { text: 'Lights' }), el('span', { text: String(app.lights.length) }),
    ]));
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Export show →', () => app.doExport(), 'primary'),
    ]));
  }
}

function numberInput(value, min, max, step, onChange) {
  const i = el('input', { type: 'number', value, min, max, step });
  i.addEventListener('change', () => {
    const v = Number(i.value);
    if (!Number.isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
  });
  return i;
}
