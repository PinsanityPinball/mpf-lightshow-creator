// Step-by-step layer builder.
//
// Seven steps, each offering obvious choices up top and the full controls
// underneath, with a live preview of the layer against the real light map so
// you can see what you are making rather than guessing from numbers.

import { LAYER_STEPS } from './steps.js';
import { SHAPES, SHAPE_BY_ID, shapeDefaults } from './shapes.js';
import {
  makeLayer, makeKey, invalidateKeys, EASE_NAMES,
  setParamRange, paramRange, setScaleRange, scaleRange, scaleIsUniform,
  setColourRange, colourRange, setRotationRange, rotationRange,
  fadeState, setFades,
} from './project.js';
import {
  PATHS, applyPath, pathOptions, pathExtent, TRANSFORMS, randomStart, randomEnd,
  SIZE_PRESETS, turnsOf, setTurns,
} from './paths.js';
import { ShowRenderer, drawLights } from './render.js';
import {
  el, clear, field, slider, selectBox, checkbox, colorInput, button, hint, round,
  rangeRow,
} from './ui.js';
import { shapeThumb } from './inspector.js';

const PALETTE = [
  '#ff2020', '#ff8000', '#ffd400', '#40ff40',
  '#00e5ff', '#2060ff', '#a040ff', '#ff40c0', '#ffffff',
];

export class Wizard {
  constructor(app) {
    this.app = app;
    this.step = 0;
    this.layer = null;
    this.pathId = null;
    this.pathOpts = pathOptions({ aspect: app.project.aspect || 0.5 });
    this.renderer = new ShowRenderer();
    this.raf = null;
    this.t0 = 0;
    // preview playback state, kept on the instance so pausing sticks for the
    // session rather than restarting every time the wizard is reopened
    this.playing = true;
    this.previewT = 0;

    this.steps = this.buildSteps();
  }

  /**
   * Order and titles come from LAYER_STEPS, which the Layer panel's sub-tabs are
   * built from too, so the two cannot drift apart. Only the builders here are
   * wizard-specific. Rebuilt on every open rather than cached in the
   * constructor: the wizard instance outlives a single use, so a cached list
   * would be the one thing that could still go out of step.
   */
  buildSteps() {
    const BUILD = {
      shape: (b) => this.stepShape(b),
      path: (b) => this.stepPath(b),
      motion: (b) => this.stepMotion(b),
      size: (b) => this.stepSize(b),
      colour: (b) => this.stepColour(b),
      lights: (b) => this.stepLights(b),
      timing: (b) => this.stepTiming(b),
    };
    return LAYER_STEPS
      .filter((s) => BUILD[s.id])
      .map((s) => ({ id: s.id, title: s.title, build: BUILD[s.id] }));
  }

  // ------------------------------------------------------------ lifecycle

  open() {
    const app = this.app;
    this.steps = this.buildSteps();
    this.step = 0;
    this.layer = makeLayer({
      name: 'New layer',
      shapeId: 'bar',
      shapeParams: Object.assign(shapeDefaults('bar'), { len: 1.4, thick: 0.16, feather: 0.5 }),
      durationMs: 1000,
      startMs: Math.round(app.renderTime()),
      // starts still and centred; step 2 is where it gets somewhere to go
      keys: [
        makeKey(0, { x: 0.5, y: 0.5, sx: 0.8, sy: 0.8, color: '#00e5ff' }),
        makeKey(1, { x: 0.5, y: 0.5, sx: 0.8, sy: 0.8, color: '#00e5ff' }),
      ],
    });
    this.pathId = 'none';
    this.previewT = 0;
    this.mount();
    this.render();
    if (this.playing) this.startPreview(); else this.drawPreview();
  }

  close() {
    this.stopPreview();
    const host = document.getElementById('wizard');
    if (host) host.classList.add('hidden');
  }

  mount() {
    let host = document.getElementById('wizard');
    if (!host) {
      host = el('div', { id: 'wizard', class: 'wiz hidden' });
      document.body.appendChild(host);
    }
    host.classList.remove('hidden');
    clear(host);

    this.crumbs = el('div', { class: 'wiz-steps' });
    this.body = el('div', { class: 'wiz-body' });
    this.preview = el('canvas', { class: 'wiz-preview' });
    this.foot = el('div', { class: 'wiz-foot' });

    host.appendChild(el('div', { class: 'wiz-box' }, [
      el('div', { class: 'wiz-head' }, [
        el('span', { text: 'Build a layer' }),
        el('button', { class: 'btn icon', html: '&times;', onclick: () => this.close() }),
      ]),
      this.crumbs,
      el('div', { class: 'wiz-main' }, [
        this.body,
        el('div', { class: 'wiz-side' }, [
          this.preview,
          this.buildPreviewControls(),
        ]),
      ]),
      this.foot,
    ]));

    // mount() runs on every open but #wizard is created once and left in the
    // DOM, so this would stack up a handler per open
    if (!host.dataset.wired) {
      host.dataset.wired = '1';
      host.addEventListener('click', (e) => { if (e.target === host) this.close(); });
    }
  }

  /** Play/pause and a scrubber, so the preview can hold still while you read. */
  buildPreviewControls() {
    this.playBtn = el('button', {
      class: 'btn icon',
      html: this.playing ? '&#10073;&#10073;' : '&#9654;',
      title: this.playing ? 'Pause the preview' : 'Play the preview',
      onclick: () => this.setPlaying(!this.playing),
    });
    this.scrub = el('input', {
      type: 'range', min: 0, max: 1000, step: 1, value: 0, class: 'wiz-scrub',
      title: 'Scrub through the clip',
    });
    this.scrub.addEventListener('input', () => {
      this.setPlaying(false);
      this.previewT = (Number(this.scrub.value) / 1000) * this.previewSpan();
      this.drawPreview();
    });
    return el('div', { class: 'wiz-playbar' }, [
      this.playBtn,
      this.scrub,
    ]);
  }

  previewSpan() {
    return Math.max(1, this.layer.durationMs * Math.max(1, this.layer.repeat || 1));
  }

  setPlaying(on) {
    this.playing = on;
    if (this.playBtn) {
      this.playBtn.innerHTML = on ? '&#10073;&#10073;' : '&#9654;';
      this.playBtn.title = on ? 'Pause the preview' : 'Play the preview';
    }
    if (on) this.startPreview();
    else this.stopPreview();
  }

  // ------------------------------------------------------------ chrome

  render() {
    clear(this.crumbs);
    this.steps.forEach((s, i) => {
      this.crumbs.appendChild(el('button', {
        class: 'wiz-crumb' + (i === this.step ? ' on' : '') + (i < this.step ? ' done' : ''),
        text: `${i + 1}. ${s.title}`,
        onclick: () => { this.step = i; this.render(); },
      }));
    });

    clear(this.body);
    this.steps[this.step].build(this.body);
    if (!this.playing) this.drawPreview();

    clear(this.foot);
    this.foot.appendChild(el('span', { class: 'muted',
      text: `Step ${this.step + 1} of ${this.steps.length}` }));
    this.foot.appendChild(el('div', { class: 'grow' }));
    if (this.step > 0) {
      this.foot.appendChild(button('Back', () => { this.step--; this.render(); }));
    }
    if (this.step < this.steps.length - 1) {
      this.foot.appendChild(button('Next', () => { this.step++; this.render(); }, 'primary'));
    }
    this.foot.appendChild(button('Create layer', () => this.finish(), 'primary'));
  }

  /** Big obvious choices, then the full controls beneath. */
  easy(parent, label, tiles) {
    parent.appendChild(el('div', { class: 'wiz-easy-label', text: label }));
    const row = el('div', { class: 'wiz-tiles' });
    for (const t of tiles) {
      row.appendChild(el('button', {
        class: 'wiz-tile' + (t.on ? ' on' : ''),
        title: t.title || t.label,
        onclick: () => { t.pick(); this.render(); },
      }, [t.icon || null, el('span', { text: t.label })]));
    }
    parent.appendChild(row);
  }

  /**
   * The full controls for a step, folded away behind a toggle.
   *
   * Every step used to show its whole control set at once, which made the
   * wizard read as a wall of sliders when the point of it is the handful of
   * obvious choices above. The detail is still one click away, and whether it
   * is open is remembered per step for as long as the wizard is open, so
   * anyone who wants it does not have to keep reopening it.
   */
  custom(parent) {
    const key = this.steps[this.step].id;
    this.advancedOpen = this.advancedOpen || {};
    const open = !!this.advancedOpen[key];

    const box = el('div', { class: 'wiz-custom' + (open ? '' : ' hidden') });
    const arrow = el('span', { class: 'wiz-adv-arrow', text: open ? '\u25be' : '\u25b8' });
    const toggle = el('button', {
      class: 'wiz-adv' + (open ? ' on' : ''),
      onclick: () => {
        const now = !this.advancedOpen[key];
        this.advancedOpen[key] = now;
        box.classList.toggle('hidden', !now);
        toggle.classList.toggle('on', now);
        arrow.textContent = now ? '\u25be' : '\u25b8';
      },
      // One label everywhere. People go looking for "advanced", not for
      // "Colour settings", and a control that reads the same on every step is
      // easier to learn once and then ignore.
    }, [arrow, el('span', { text: 'Advanced options' })]);

    parent.appendChild(toggle);
    parent.appendChild(box);
    return box;
  }

  /**
   * The layer's easing, offered on every step that animates something. It is
   * one setting shown in several places, not one per property - you are asking
   * "how should this move", and that question belongs next to whatever you are
   * currently adjusting rather than only on the Motion step.
   */
  easingRow(box) {
    const L = this.layer;
    const cur = (L.keys[0] && L.keys[0].ease) || 'linear';
    box.appendChild(field('Easing', selectBox(cur, EASE_NAMES, (v) => {
      for (const k of L.keys) k.ease = v;
      this.render();
    }), { title: 'How the layer moves between keyframes. Shared by every step.' }));
  }

  // ------------------------------------------------------------ steps

  stepShape(b) {
    const L = this.layer;
    const app = this.app;
    const current = SHAPE_BY_ID.get(L.shapeId);
    const showAll = app.showAllShapes || !(current && current.common);
    const shown = SHAPES.filter((s) => s.common || showAll);

    this.easy(b, 'Pick a shape', shown.map((s) => ({
      label: s.label, on: L.shapeId === s.id, icon: shapeThumb(s.id),
      pick: () => {
        L.shapeId = s.id;
        L.shapeParams = shapeDefaults(s.id);
        L.animParams = [];
        for (const k of L.keys) k.params = {};
      },
    })));
    const hidden = SHAPES.length - shown.length;
    if (hidden > 0 || app.showAllShapes) {
      b.appendChild(el('div', { class: 'btn-row' }, [
        button(hidden > 0 ? `Show ${hidden} more shapes` : 'Show fewer shapes', () => {
          app.showAllShapes = !app.showAllShapes;
          this.render();
        }, 'small'),
      ]));
    }

    const c = this.custom(b, 'Shape settings');
    const def = SHAPE_BY_ID.get(L.shapeId);
    if (def && def.isImage) {
      c.appendChild(field('PNG', selectBox(L.image,
        this.app.shapeFiles.length ? this.app.shapeFiles : [L.image],
        (v) => { L.image = v; this.app.preloadImage(v); })));
    }
    if (def) {
      c.appendChild(hint('Give a setting different start and end values and it will '
        + 'animate across the clip - that is how you get an arc that fills or a ring '
        + 'that grows.'));
      // overall size lives here too, since this is where you are judging the shape
      const sr = scaleRange(L, 'x');
      c.appendChild(this.rangeRow('Overall size', { min: 0.02, max: 3, step: 0.01 }, sr,
        (from, to) => setScaleRange(L, from, to, scaleIsUniform(L) ? 'both' : 'x')));
      for (const p of def.params) {
        if (p.type === 'bool') {
          c.appendChild(el('div', { class: 'btn-row' }, [
            checkbox(p.label, L.shapeParams[p.key] !== false, (v) => {
              L.shapeParams[p.key] = v;
              this.render();
            }),
          ]));
          continue;
        }
        c.appendChild(this.rangeRow(p.label, p, paramRange(L, p.key),
          (from, to) => setParamRange(L, p.key, from, to)));
      }
      this.easingRow(c);
    }
  }

  /** Start/end pair. Shared with the Layer panel so both look identical. */
  rangeRow(label, spec, current, apply) {
    return rangeRow(label, spec, current, apply,
      () => { if (!this.playing) this.drawPreview(); });
  }

  stepPath(b) {
    const L = this.layer;
    const apply = (id) => {
      this.pathId = id;
      applyPath(L, id, Object.assign({}, this.pathOpts, {
        aspect: this.app.project.aspect || 0.5,
        points: id === 'diagonal' || id === 'sweep-up' ? 2 : (id === 'sides' ? 4 : 24),
      }));
    };

    this.easy(b, 'How does it travel?', PATHS.map((p) => ({
      label: p.label, on: this.pathId === p.id, pick: () => apply(p.id),
    })));

    const c = this.custom(b, 'Advanced options');
    const o = this.pathOpts;
    const re = () => { if (this.pathId) apply(this.pathId); };

    // Only the controls this path actually reads. A circle ignores Loops and a
    // straight sweep ignores Size, so showing them invited people to drag a
    // slider and watch nothing happen.
    const def = PATHS.find((p) => p.id === this.pathId);
    const uses = (def && def.uses) || [];
    const usable = (name) => uses.includes(name);

    if (usable('r')) {
      c.appendChild(slider('Size', o.r, { min: 0.05, max: 0.8, step: 0.01 },
        (v) => { o.r = v; re(); }));
    }
    if (usable('turns')) {
      c.appendChild(slider((def && def.turnLabel) || 'Loops', o.turns,
        { min: 1, max: 8, step: 1 }, (v) => { o.turns = v; re(); }));
    }
    if (usable('overshoot')) {
      c.appendChild(slider('Off-screen margin', o.overshoot, { min: 0, max: 0.5, step: 0.01 },
        (v) => { o.overshoot = v; re(); }));
    }
    if (usable('inward')) {
      c.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Spiral inwards', !!o.inward, (v) => { o.inward = v; re(); }),
      ]));
    }
    this.easingRow(c);
    if (this.pathId === 'none') {
      c.appendChild(hint('A stationary layer has nothing to steer. Pick a path above '
        + 'to get its settings, or drag the shape on the playfield afterwards.'));
    }
    c.appendChild(el('div', { class: 'btn-row' }, [
      button('Random start', () => { randomStart(L); invalidateKeys(L); this.render(); }, 'small'),
      button('Random exit', () => { randomEnd(L); invalidateKeys(L); this.render(); }, 'small'),
      ...TRANSFORMS.filter((t) => t.id.startsWith('mirror') || t.id === 'reverse-path')
        .map((t) => button(t.label, () => {
          t.apply(L); invalidateKeys(L); this.render();
        }, 'small')),
    ]));
    if (this.pathId && this.pathId !== 'none') {
      const ext = pathExtent(this.pathId, Object.assign({}, o, {
        aspect: this.app.project.aspect || 0.5,
        points: this.pathId === 'diagonal' || this.pathId === 'sweep-up' ? 2
          : (this.pathId === 'sides' ? 4 : 24),
      }));
      const pct = (v) => Math.round(v * 100);
      c.appendChild(hint(`Covers about ${pct(ext.w)}% of the width and ${pct(ext.h)}% of `
        + 'the height. Size means the same on both axes, so at the top of its range '
        + 'a path reaches the edges of the playfield.'
        + (ext.w > 1.05 || ext.h > 1.05 ? ' Part of this path runs off the playfield.' : '')));
    }
    c.appendChild(hint(`${L.keys.length} keyframes. You can still drag them on the `
      + 'playfield after the layer is created.'));
  }

  /**
   * A numeric field that re-renders on change.
   *
   * This lived inside stepTiming as a local. The moment a second step needed
   * one it threw a ReferenceError, and because a step builds into a container
   * rather than returning markup, the step just stopped half-built with no
   * visible error - the controls after it simply were not there.
   */
  num(label, value, min, max, step, onChange) {
    const i = el('input', { type: 'number', value, min, max, step });
    i.addEventListener('change', () => {
      const v = Number(i.value);
      if (!Number.isNaN(v)) { onChange(Math.max(min, Math.min(max, v))); this.render(); }
    });
    return field(label, i);
  }

  stepMotion(b) {
    const L = this.layer;
    const turns = turnsOf(L);
    this.easy(b, 'How many turns?', [0, 1, 2, 3, 5, -1].map((n) => ({
      label: n === 0 ? 'None' : (n > 0 ? `${n} turn${n === 1 ? '' : 's'}` : `${-n} back`),
      on: Math.abs(turns - n) < 0.01,
      pick: () => setTurns(L, n),
    })));

    const c = this.custom(b, 'Motion settings');
    const def = SHAPE_BY_ID.get(L.shapeId);
    if (def && def.symmetric) {
      c.appendChild(hint(`A ${def.label.toLowerCase()} looks the same at every angle, `
        + 'so orientation makes no visible difference to it.'));
    } else {
      const rr = rotationRange(L);
      c.appendChild(this.rangeRow('Orientation', { min: -1080, max: 1080, step: 5 }, rr,
        (from, to) => setRotationRange(L, from, to)));
      c.appendChild(hint('The angle it starts and ends at. A difference of 360 is one '
        + 'full turn, so this and the turn buttons above are two views of the same thing.'));
    }
    c.appendChild(slider('Rotations', turns, { min: -20, max: 20, step: 0.5 },
      (v) => { setTurns(L, v); }));
    this.easingRow(c);
    c.appendChild(el('div', { class: 'btn-row' },
      TRANSFORMS.filter((t) => t.id.startsWith('rotate')).map((t) => button(t.label, () => {
        t.apply(L); invalidateKeys(L); this.render();
      }, 'small'))));
    c.appendChild(hint('Turns are spread evenly across the clip by time, so the spin '
      + 'runs at a constant rate.'));
    // Moved here from Timing to match the Layer panel: repeating the gesture is
    // part of what the movement does.
    c.appendChild(this.num('Repeat', L.repeat || 1, 1, 200, 1, (v) => { L.repeat = Math.round(v); }));
    c.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Ping-pong', L.pingpong, (v) => {
        L.pingpong = v;
        // nothing to reverse at repeat 1, so give it a second pass
        if (v && (L.repeat || 1) < 2) L.repeat = 2;
        else if (!v && (L.repeat || 1) === 2) L.repeat = 1;
        this.render();
      }),
    ]));
  }

  stepSize(b) {
    const L = this.layer;
    const rx = scaleRange(L, 'x');
    const ry = scaleRange(L, 'y');
    const uniform = scaleIsUniform(L);
    const same = Math.abs(rx.from - rx.to) < 0.001 && Math.abs(ry.from - ry.to) < 0.001;
    const spec = { min: 0.02, max: 3, step: 0.01 };

    this.easy(b, 'How big?', SIZE_PRESETS.map((s) => ({
      label: s.label, title: `scale ${s.scale}`,
      on: same && uniform && Math.abs(rx.from - s.scale) < 0.001,
      pick: () => setScaleRange(L, s.scale, s.scale, 'both'),
    })));
    this.easy(b, 'Does it change size?', [
      { label: 'Stays the same', on: same,
        pick: () => setScaleRange(L, rx.from, rx.from, 'both') },
      { label: 'Grows', on: !same && rx.to > rx.from,
        pick: () => setScaleRange(L, rx.from, rx.from * 3, 'both') },
      { label: 'Shrinks', on: !same && rx.to < rx.from,
        pick: () => setScaleRange(L, rx.from, Math.max(0.02, rx.from * 0.1), 'both') },
      { label: uniform ? 'Same width & height' : 'Separate width & height',
        title: 'Toggle whether the two axes move together',
        on: !uniform,
        pick: () => {
          if (uniform) setScaleRange(L, rx.from, rx.to * 2, 'x');
          else { setScaleRange(L, rx.from, rx.to, 'both'); }
        } },
    ]);

    const c = this.custom(b, 'Size settings');
    if (uniform) {
      c.appendChild(this.rangeRow('Scale', spec, rx,
        (from, to) => setScaleRange(L, from, to, 'both')));
      c.appendChild(hint('Width and height move together. Use "Separate width & height" '
        + 'above to stretch one axis on its own.'));
    } else {
      c.appendChild(this.rangeRow('Width', spec, rx,
        (from, to) => setScaleRange(L, from, to, 'x')));
      c.appendChild(this.rangeRow('Height', spec, ry,
        (from, to) => setScaleRange(L, from, to, 'y')));
      c.appendChild(el('div', { class: 'btn-row' }, [
        button('Match height to width', () => {
          setScaleRange(L, rx.from, rx.to, 'both'); this.render();
        }, 'small'),
      ]));
    }
    this.easingRow(c);
  }

  stepColour(b) {
    const L = this.layer;
    const r = colourRange(L);
    const same = r.from.toLowerCase() === r.to.toLowerCase();
    const swatch = (hex) => { const d = el('span', { class: 'wiz-dot' }); d.style.background = hex; return d; };

    this.easy(b, same ? 'Pick a colour' : 'Start colour', PALETTE.map((hex) => ({
      label: '', icon: swatch(hex), title: hex,
      on: r.from.toLowerCase() === hex.toLowerCase(),
      pick: () => setColourRange(L, hex, same ? hex : r.to),
    })));
    this.easy(b, 'Does it change colour?', [
      { label: 'One colour', on: same, pick: () => setColourRange(L, r.from, r.from) },
      { label: 'Fades to another', on: !same,
        pick: () => setColourRange(L, r.from, r.from === '#ffffff' ? '#2060ff' : '#ffffff') },
    ]);
    if (!same) {
      this.easy(b, 'End colour', PALETTE.map((hex) => ({
        label: '', icon: swatch(hex), title: hex,
        on: r.to.toLowerCase() === hex.toLowerCase(),
        pick: () => setColourRange(L, r.from, hex),
      })));
    }

    const c = this.custom(b, 'Colour settings');
    c.appendChild(field('Fill', selectBox(L.colorMode, [
      ['solid', 'Solid'], ['gradient', 'Two-colour gradient'], ['rainbow', 'Rainbow'],
    ], (v) => { L.colorMode = v; this.render(); })));
    // Read the range at the moment of the change, not at build time. The
    // captured `r` went stale as soon as either picker was used, so setting an
    // end colour wrote back the start colour from before you changed it.
    c.appendChild(field('Start colour', colorInput(r.from, (v) => {
      setColourRange(L, v, colourRange(L).to);
      if (!this.playing) this.drawPreview();
    })));
    c.appendChild(field('End colour', colorInput(r.to, (v) => {
      setColourRange(L, colourRange(L).from, v);
      if (!this.playing) this.drawPreview();
    })));
    c.appendChild(field('Tween through', selectBox(L.colorLerp, [
      ['rgb', 'RGB (direct)'], ['hsl', 'HSL (around the wheel)'],
    ], (v) => { L.colorLerp = v; setColourRange(L, r.from, r.to); })));
    const fades = fadeState(L);
    c.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Fade in', fades.in, (v) => {
        setFades(L, v, fades.out); this.render();
      }),
      checkbox('Fade out', fades.out, (v) => {
        setFades(L, fades.in, v); this.render();
      }),
    ]));
    c.appendChild(hint('Fades ramp the layer up from black at the start and back down '
      + 'at the end. Turning both on keeps a bright middle rather than leaving the '
      + 'layer dark the whole way through.'));
    this.easingRow(c);
    // Blend moved here from Timing to match the Layer panel: it is a colour
    // question, not a clock one.
    c.appendChild(field('Blend', selectBox(L.blend, [
      ['add', 'Add (lights stack)'], ['normal', 'Normal (covers)'],
      ['average', 'Average (blends colours)'],
      ['erase', 'Erase (turns lights off)'],
    ], (v) => { L.blend = v; })));
  }

  stepLights(b) {
    const L = this.layer;
    const app = this.app;
    const top = app.tags.slice(0, 8);
    const tiles = [{
      label: 'Every light', on: L.target.mode !== 'tags',
      pick: () => { L.target.mode = 'all'; L.target.tags = []; },
    }].concat(top.map((t) => ({
      label: `${t.tag} (${t.count})`,
      on: L.target.mode === 'tags' && L.target.tags.includes(t.tag),
      pick: () => { L.target.mode = 'tags'; L.target.tags = [t.tag]; },
    })));
    this.easy(b, 'Which lights?', tiles);

    const c = this.custom(b, 'Light settings');
    if (!app.tags.length) {
      c.appendChild(hint('No tags loaded - pick a lights.yaml in the Tags dropdown to '
        + 'target groups of lights.'));
    } else {
      const chips = el('div', { class: 'chips' });
      for (const { tag, count } of app.tags) {
        chips.appendChild(el('button', {
          class: 'chip' + (L.target.tags.includes(tag) ? ' on' : ''),
          onclick: () => {
            L.target.mode = 'tags';
            const i = L.target.tags.indexOf(tag);
            if (i >= 0) L.target.tags.splice(i, 1); else L.target.tags.push(tag);
            if (!L.target.tags.length) L.target.mode = 'all';
            this.render();
          },
        }, [el('span', { text: tag }), el('i', { text: String(count) })]));
      }
      c.appendChild(chips);
      c.appendChild(field('Match', selectBox(L.target.match, [
        ['any', 'Any of the tags'], ['all', 'All of the tags'],
      ], (v) => { L.target.match = v; })));
      c.appendChild(el('div', { class: 'btn-row' }, [
        checkbox('Invert', L.target.invert, (v) => { L.target.invert = v; this.render(); }),
      ]));
      const ex = el('div', { class: 'chips' });
      for (const { tag, count } of app.tags.slice(0, 12)) {
        ex.appendChild(el('button', {
          class: 'chip' + ((L.target.exclude || []).includes(tag) ? ' off' : ''),
          title: `never light the ${count} "${tag}" lights`,
          onclick: () => {
            L.target.exclude = L.target.exclude || [];
            const i = L.target.exclude.indexOf(tag);
            if (i >= 0) L.target.exclude.splice(i, 1); else L.target.exclude.push(tag);
            this.render();
          },
        }, [el('span', { text: tag }), el('i', { text: String(count) })]));
      }
      c.appendChild(el('div', { class: 'wiz-custom-label', text: 'But never these' }));
      c.appendChild(ex);
    }
    c.appendChild(hint(`${app.countTargeted(L)} of ${app.lights.length} lights selected.`));
  }

  stepTiming(b) {
    const L = this.layer;
    this.easy(b, 'How long?', [250, 500, 1000, 2000, 4000].map((ms) => ({
      label: ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`,
      on: L.durationMs === ms,
      pick: () => { L.durationMs = ms; },
    })));

    const c = this.custom(b, 'Timing settings');
    const nameInput = el('input', { type: 'text', value: L.name });
    nameInput.addEventListener('change', () => { L.name = nameInput.value; });
    c.appendChild(field('Name', nameInput));
    c.appendChild(this.num('Start (ms)', L.startMs, 0, 600000, 10, (v) => { L.startMs = Math.round(v); }));
    c.appendChild(this.num('Length (ms)', L.durationMs, 16, 600000, 10, (v) => { L.durationMs = Math.round(v); }));
    c.appendChild(el('div', { class: 'btn-row' }, [
      checkbox('Visible after', L.holdAfter, (v) => { L.holdAfter = v; }),
    ]));
    c.appendChild(hint(`Runs ${L.startMs} to `
      + `${L.startMs + L.durationMs * Math.max(1, L.repeat || 1)} ms.`));

    // sample rate belongs to the whole show, but this is where you think about time
    const fps = this.app.project.fps;
    c.appendChild(el('div', { class: 'wiz-custom-label', text: 'Whole show' }));
    c.appendChild(slider('Sample rate (Hz)', fps, { min: 10, max: 60, step: 1 }, (v) => {
      this.app.project.fps = Math.round(v);
      this.app.requestDraw();
    }));
    c.appendChild(hint(`Currently ${fps} Hz, so one step is ${(1000 / fps).toFixed(1)} ms. `
      + 'This is smoothness versus file size only - it does not change how fast the show '
      + 'plays. It applies to the whole show, not just this layer.'));
  }

  // ------------------------------------------------------------ preview

  startPreview() {
    this.stopPreview();
    this.t0 = performance.now() - this.previewT;
    const tick = () => {
      if (!this.playing) { this.raf = null; return; }
      this.previewT = (performance.now() - this.t0) % this.previewSpan();
      this.drawPreview();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopPreview() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  drawPreview() {
    const app = this.app;
    const cv = this.preview;
    if (!cv || !cv.isConnected) return;

    const aspect = app.project.aspect || 0.5;
    const w = 150, h = Math.round(w / aspect);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== w * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // the layer's own clip, ignoring where it sits on the show timeline
    const span = this.previewSpan();
    const t = Math.max(0, Math.min(span, this.previewT));
    if (this.scrub && document.activeElement !== this.scrub) {
      this.scrub.value = Math.round((t / span) * 1000);
    }
    const probe = { layers: [Object.assign({}, this.layer, { startMs: 0 })], aspect };
    const colors = this.renderer.render(probe, app.lights, t, app.project.export);

    ctx.drawImage(this.renderer.canvas, 0, 0, w, h);
    drawLights(ctx, app.lights, colors, {
      w, h, sizeScale: 0.8, showOff: true, glow: true, selected: null,
      dimmed: null,
    });
  }

  // ------------------------------------------------------------ finish

  finish() {
    const app = this.app;
    app.pushUndo('build layer');
    invalidateKeys(this.layer);
    app.project.layers.push(this.layer);
    app.selectedLayerId = this.layer.id;
    app.selectedKeyIndex = 0;
    app.rebuildHeads();
    app.inspector.refresh();
    app.requestDraw();
    this.close();
    return this.layer;
  }
}
