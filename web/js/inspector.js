// Builds the four right-hand panels. Everything writes straight into the
// project and asks the app to redraw.

import { SHAPES, SHAPE_BY_ID, shapeDefaults } from './shapes.js';
import {
  EASE_NAMES, makeKey, invalidateKeys, projectDuration, frameCount, layerEndMs,
  animateParam, unanimateParam, effectiveParams,
} from './project.js';
import { showCoverage, layerMask } from './render.js';
import {
  PATHS, applyPath, TRANSFORMS, randomStart, randomEnd, SIZE_PRESETS, applySize,
  turnsOf, setTurns,
} from './paths.js';
import { orderedTargets } from './project.js';
import {
  el, clear, field, slider, selectBox, checkbox, colorInput, button, section, hint,
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
    return [
      ['shape', 'Shape'], ['path', 'Path'], ['motion', 'Motion'],
      ['colour', 'Colour'], ['lights', 'Lights'], ['timing', 'Timing'],
    ];
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
    const name = el('input', { type: 'text', value: layer.name });
    name.addEventListener('change', () => edit('rename', () => {
      layer.name = name.value; app.rebuildHeads();
    }));
    root.appendChild(el('div', { class: 'layer-head' }, [
      name,
      checkbox('On', layer.enabled, (v) => edit('enable', () => {
        layer.enabled = v; app.rebuildHeads();
      })),
      button('Save', () => app.saveEffectDialog(false), 'small'),
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

    root.appendChild(section('Size'));
    root.appendChild(el('div', { class: 'btn-row' },
      SIZE_PRESETS.map((sz) => button(sz.label, () => edit('size ' + sz.label, () => {
        applySize(layer, sz.scale, true);
        this.app.refreshInspector();
      }), 'small'))));
    root.appendChild(hint('Sets every keyframe to that size. The Keyframe tab sizes '
      + 'one keyframe on its own.'));
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
    root.appendChild(el('div', { class: 'btn-row' }, [
      button('Fade in', () => edit('fade in', () => { layer.keys[0].alpha = 0; }), 'small'),
      button('Fade out', () => edit('fade out', () => {
        layer.keys[layer.keys.length - 1].alpha = 0;
      }), 'small'),
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
      (v) => edit('start', () => { layer.startMs = v; }))));
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

    root.appendChild(section('Blend'));
    root.appendChild(field('Mode', selectBox(layer.blend, [
      ['add', 'Add (lights stack)'], ['normal', 'Normal (covers)'],
    ], (v) => edit('blend', () => { layer.blend = v; }))));
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
    options.push(['__add__', 'Add a folder\u2026']);

    const current = app.destination();
    const sel = selectBox(
      options.some((o) => o[0] === current) ? current : 'exports',
      options,
      (v) => {
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
      ['solid', 'Solid colour'],
    ], (v) => edit('pattern type', () => { p.type = v; this.buildLayer(); }))));
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
        ['y', 'Up the playfield'], ['x', 'Across the playfield'], ['radial', 'Out from the centre'],
      ], (v) => edit('wave axis', () => { p.axis = v; this.buildLayer(); }))));
      root.appendChild(slider('Wavelength', p.wavelength, { min: 0.05, max: 2, step: 0.05 },
        this.live(`${layer.id}:pwl`, 'wavelength', (v) => { p.wavelength = v; })));
      root.appendChild(field('Cycle (ms)', numberInput(p.periodMs, 50, 60000, 50,
        (v) => edit('wave period', () => { p.periodMs = Math.max(50, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(slider('Trough brightness', p.floorLevel, { min: 0, max: 1, step: 0.05 },
        this.live(`${layer.id}:pfloor`, 'trough', (v) => { p.floorLevel = v; })));
      root.appendChild(slider('Crest sharpness', p.sharpness, { min: 0.2, max: 6, step: 0.1 },
        this.live(`${layer.id}:psharp`, 'sharpness', (v) => { p.sharpness = v; })));
      root.appendChild(hint('The wave runs across the real light positions, so it follows '
        + 'your playfield layout rather than a drawn shape.'));
    }

    if (p.type === 'stack') {
      root.appendChild(field('Second colour', colorInput(p.color2,
        this.live(`${layer.id}:pcolor2`, 'colour', (v) => { p.color2 = v; }))));
      root.appendChild(slider('Columns', p.cols, { min: 1, max: 16, step: 1 },
        this.live(`${layer.id}:pcols`, 'columns', (v) => { p.cols = Math.round(v); })));
      root.appendChild(slider('Rows', p.rows, { min: 1, max: 24, step: 1 },
        this.live(`${layer.id}:prows`, 'rows', (v) => { p.rows = Math.round(v); })));
      root.appendChild(field('Fill time (ms)', numberInput(p.fillMs, 50, 120000, 50,
        (v) => edit('fill time', () => { p.fillMs = Math.max(50, Math.round(v)); this.buildLayer(); }))));
      root.appendChild(field('Fills', selectBox(p.fillOrder, [
        ['bottom-up', 'Bottom to top'], ['top-down', 'Top to bottom'],
        ['left-right', 'Left to right'], ['right-left', 'Right to left'],
      ], (v) => edit('fill order', () => { p.fillOrder = v; this.buildLayer(); }))));
      root.appendChild(field('Mode', selectBox(p.fillMode, [
        ['fill', 'Cells stay lit'], ['wipe', 'Only the leading cell'],
      ], (v) => edit('fill mode', () => { p.fillMode = v; this.buildLayer(); }))));
      root.appendChild(hint(`${p.cols} x ${p.rows} = ${p.cols * p.rows} cells over `
        + `${p.fillMs} ms, so a cell lands every ${Math.round(p.fillMs / (p.cols * p.rows))} ms.`));
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
    ], (v) => edit('blend', () => { layer.blend = v; }))));

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
      : 'No lights selected yet. Pick tags under "Applies to" above.'));
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
    ], (v) => edit('blend', () => { layer.blend = v; }))));
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

  buildExport() {
    const app = this.app;
    const root = clear(this.panels.export);
    const p = app.project;
    const x = p.export;
    const edit = (label, fn) => { app.pushUndo(label); fn(); app.onProjectEdit({}); };

    root.appendChild(section('MPF version'));
    root.appendChild(field('Target', selectBox(x.mpfTarget || '0.80', [
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

    root.appendChild(section('Blending'));
    root.appendChild(field('Layers add in', selectBox(x.blend || 'linear', [
      ['linear', 'Linear light (physical)'],
      ['srgb', 'sRGB (original tool)'],
    ], (v) => edit('blend', () => { x.blend = v; this.buildExport(); }))));
    root.appendChild(hint(x.blend === 'srgb'
      ? 'Adds the encoded 8-bit values, like the original tool did. Overlaps come '
        + 'out brighter than the hardware will actually produce.'
      : 'Converts to linear light before adding, which is how real LEDs combine. '
        + 'Overlapping layers land where the machine will put them.'));

    root.appendChild(section('Sampling'));
    root.appendChild(field('Colour', selectBox(x.mode, [
      ['colour', 'Full colour'],
      ['threshold', 'Cut dark values'],
      ['bw', 'Black & white'],
    ], (v) => edit('mode', () => { x.mode = v; this.buildExport(); }))));
    if (x.mode !== 'colour') {
      root.appendChild(slider('Threshold', x.threshold, { min: 1, max: 254, step: 1 },
        this.live('export:threshold', 'threshold', (v) => { x.threshold = v; })));
    }
    root.appendChild(slider('Sample radius (px)', x.sampleRadius, { min: 0, max: 8, step: 1 },
      this.live('export:sampleRadius', 'sample radius', (v) => { x.sampleRadius = v; })));
    root.appendChild(hint('0 samples a single pixel like the original tool. 2–3 gives smoother, less jittery output.'));
    root.appendChild(slider('Gamma', x.gamma, { min: 0.3, max: 3, step: 0.05 },
      this.live('export:gamma', 'gamma', (v) => { x.gamma = v; })));
    root.appendChild(slider('Minimum lit level', x.minLevel, { min: 0, max: 128, step: 1 },
      this.live('export:minLevel', 'minimum level', (v) => { x.minLevel = v; })));
    root.appendChild(hint('Lifts dim pixels so faint edges still light an LED.'));

    root.appendChild(section('YAML output'));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Only changed lights per step', x.diffOnly !== false,
        (v) => edit('diff', () => { x.diffOnly = v; })),
    ]));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Write "stop" for black', !!x.blackAsStop,
        (v) => edit('stop', () => { x.blackAsStop = v; })),
    ]));
    root.appendChild(field('Fade (ms)', numberInput(x.fadeMs || 0, 0, 5000, 1,
      (v) => edit('fade', () => { x.fadeMs = Math.max(0, Math.round(v)); }))));
    root.appendChild(hint('0 = no fade key, matching the original output.'));

    root.appendChild(section('Dead frames'));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Trim dark frames at the start', x.trimStart === true,
        (v) => edit('trim start', () => { x.trimStart = v; this.buildExport(); })),
    ]));
    root.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Trim dark frames at the end', x.trimEnd !== false,
        (v) => edit('trim end', () => { x.trimEnd = v; this.buildExport(); })),
    ]));
    root.appendChild(hint(x.trimStart
      ? 'Trimming the start shifts every cue earlier by however much silence is '
        + 'removed. Leave it off for a show cut to audio or video.'
      : 'Leading silence is kept, so the show stays in sync with whatever you '
        + 'timed it against.'));
    root.appendChild(field('Idle steps', selectBox(x.idleMode || 'hold', [
      ['hold', 'Restate previous colours'],
      ['collapse', 'Merge into the next step (+N)'],
      ['bare', 'Time-only step (original tool)'],
    ], (v) => edit('idle mode', () => { x.idleMode = v; this.buildExport(); }))));
    root.appendChild(hint(x.idleMode === 'bare'
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
