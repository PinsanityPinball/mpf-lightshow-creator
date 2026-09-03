// Application controller: owns the project, the playback clock, undo/redo and
// all the wiring between the stage, the timeline and the inspector.

import {
  makeProject, normaliseProject, serialiseProject, makeKey, makeShowLayer,
  projectDuration, frameCount, msPerFrame, invalidateKeys, stateAt, layerStateAtTime,
} from './project.js';
import { ShowRenderer, preloadShapeImages, loadShapeImage, layerMask } from './render.js';
import { Stage } from './stage.js';
import { Timeline } from './timeline.js';
import { Inspector, shapeThumb } from './inspector.js';
import { PRESETS, PRESET_COLOURS } from './presets.js';
import { PATHS, applyPath, TRANSFORMS, randomStart, randomEnd, SIZE_PRESETS, applySize } from './paths.js';
import {
  makeEffect, listEffects, loadEffect, saveEffect, deleteEffect, instantiate, tagCoverage,
} from './effects.js';
import { Wizard } from './wizard.js';
import { buildShow, suggestFilename } from './exporter.js';
import {
  el, $, $$, clear, button, showModal, hideModal, status, api, apiPost, fmtMs,
  confirmModal, field,
} from './ui.js';

// A run of edits to one control within this window folds into a single undo.
const COALESCE_MS = 700;

class App {
  constructor() {
    // opens empty: the empty state invites the first layer rather than
    // presenting one the user did not ask for
    this.project = makeProject();
    this.lights = [];
    this.tags = [];              // [{tag, count}] from the paired lights.yaml
    this.tagFiles = [];
    this.shapeFiles = [];
    this.config = {};            // remembered workspace, from config.json
    this.folders = { folders: [], discovered: [], exportsDir: '', target: 'exports' };
    this.backgroundImage = null;
    this.showAllShapes = false;   // the picker starts with the everyday shapes
    this.mapMtime = 0;           // freshness of the loaded light map on disk
    this.tagMtime = 0;
    this.mapStale = false;
    this.renderer = new ShowRenderer();
    this.colors = null;

    this.timeMs = 0;
    this.playing = false;
    this.loop = true;
    this.speed = 1;
    this.zoom = 1;

    this.view = 'both';
    this.showOff = true;
    this.glow = true;
    this.onion = false;
    this.showPath = true;
    this.lightSize = 1;
    this.autoKey = true;

    this.selectedLayerId = null;
    this.selectedKeyIndex = 0;
    this.pinnedLights = new Set();
    this.keyClipboard = null;

    this.undoStack = [];
    this.redoStack = [];
    this.undoKey = null;
    this.undoAt = 0;
    this.dirty = true;
    this.savedName = null;

    this.stage = new Stage(this, $('#stage'));
    this.timeline = new Timeline(this, $('#timelineCanvas'), $('#heads'));
    this.inspector = new Inspector(this);
  }

  // ------------------------------------------------------------ startup

  async init() {
    this.wireChrome();
    this.wireKeys();

    try {
      const [maps, tagfiles, shapes, config] = await Promise.all([
        api('/api/lightmaps'),
        api('/api/tagfiles'),
        api('/api/shapes'),
        api('/api/config'),
      ]);
      this.shapeFiles = shapes.shapes || [];
      this.config = config || {};
      this.tagFiles = tagfiles.tagfiles || [];

      const sel = $('#lightMap');
      clear(sel);
      for (const m of maps.lightmaps) sel.appendChild(el('option', { value: m, text: m }));
      this.rebuildTagFileSelect();

      if (maps.lightmaps.length) {
        // last used map wins, then monitor.yaml, then whatever is first
        const remembered = this.config.lightMap;
        const preferred = maps.lightmaps.includes(remembered) ? remembered
          : (maps.lightmaps.includes('monitor.yaml') ? 'monitor.yaml' : maps.lightmaps[0]);
        sel.value = preferred;
        const keepTags = this.tagFiles.includes(this.config.tagFile) ? this.config.tagFile : null;
        await this.loadLightMap(preferred, keepTags, { remember: false });
      } else {
        status('No light maps found. Drop a monitor.yaml into the lightmaps folder.', 'err');
      }

      await this.loadFolders();
      if (this.config.background) {
        this.setBackground(this.config.background, { remember: false, undo: false });
      }

      await preloadShapeImages(this.shapeFiles.slice(0, 40));
    } catch (err) {
      status('Startup problem: ' + err.message, 'err');
    }

    if (this.project.layers.length) this.selectLayer(this.project.layers[0].id);
    this.rebuildHeads();
    this.resizeAll();
    this.inspector.refresh();
    this.rebuildHeads();
    window.addEventListener('resize', () => this.resizeAll());

    // Notice edits made to the light map outside the app.
    window.addEventListener('focus', () => this.checkMapFreshness());
    setInterval(() => this.checkMapFreshness(), 10000);

    this.lastTick = performance.now();
    requestAnimationFrame((t) => this.tick(t));
  }

  resizeAll() {
    this.stage.fit();
    this.timeline.fit();
    this.requestDraw();
  }

  onAspectChange() {
    this.renderer.resize(this.project.aspect);
    this.resizeAll();
  }

  // ------------------------------------------------------------ clock

  tick(now) {
    const dt = Math.min(100, now - this.lastTick);
    this.lastTick = now;

    if (this.playing) {
      const dur = projectDuration(this.project);
      let t = this.timeMs + dt * this.speed;
      if (t >= dur) {
        if (this.loop) t = t % dur;
        else { t = dur; this.setPlaying(false); }
      }
      this.timeMs = t;
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    requestAnimationFrame((n) => this.tick(n));
  }

  /** Playback and export both land on exact frame boundaries. */
  renderTime() {
    const mpf = msPerFrame(this.project);
    return Math.round(Math.floor(this.timeMs / mpf + 1e-6) * mpf * 1000) / 1000;
  }

  draw() {
    this.colors = this.renderer.render(this.project, this.lights, this.renderTime());
    this.stage.draw(this.colors);
    this.timeline.draw();

    const mpf = msPerFrame(this.project);
    $('#timeNow').textContent = fmtMs(this.timeMs);
    $('#timeTotal').textContent = fmtMs(projectDuration(this.project));
    $('#frameNow').textContent = String(Math.floor(this.timeMs / mpf));
    $('#frameTotal').textContent = String(frameCount(this.project));
  }

  requestDraw() { this.dirty = true; }

  setTime(ms) {
    const dur = projectDuration(this.project);
    this.timeMs = Math.max(0, Math.min(dur, ms));
    this.requestDraw();
  }

  stepFrame(n) {
    const mpf = msPerFrame(this.project);
    this.setTime(Math.round(this.timeMs / mpf) * mpf + n * mpf);
  }

  setPlaying(on) {
    this.playing = on;
    $('#btnPlay').classList.toggle('playing', on);
    $('#btnPlay').innerHTML = on ? '&#10073;&#10073;' : '&#9654;';
  }

  setZoom(z) {
    this.zoom = Math.max(0.25, Math.min(8, z));
    $('#rngZoom').value = this.zoom;
    this.requestDraw();
  }

  snapMs() { return msPerFrame(this.project); }

  // ------------------------------------------------------------ selection

  selectedLayer() {
    return this.project.layers.find((l) => l.id === this.selectedLayerId) || null;
  }

  selectLayer(id) {
    if (this.selectedLayerId === id) return;
    this.selectedLayerId = id;
    this.selectedKeyIndex = 0;
    this.rebuildHeads();
    this.inspector.refresh();
    this.requestDraw();
  }

  selectKey(i) {
    const layer = this.selectedLayer();
    if (!layer) return;
    this.selectedKeyIndex = Math.max(0, Math.min(layer.keys.length - 1, i));
    this.requestDraw();
  }

  toggleLightPin(index, additive) {
    if (!additive) this.pinnedLights.clear();
    if (this.pinnedLights.has(index)) this.pinnedLights.delete(index);
    else this.pinnedLights.add(index);
  }

  /**
   * The keyframe an edit should be written to.
   * With auto-key on, that is the keyframe under the playhead - created if it
   * does not exist yet. Otherwise it is whichever key is selected.
   */
  targetKey(layer) {
    if (!layer.keys.length) {
      layer.keys.push(makeKey(0));
      invalidateKeys(layer);
    }
    const sorted = layer.keys.slice().sort((a, b) => a.t - b.t);
    if (!this.autoKey) return layer.keys[Math.min(this.selectedKeyIndex, layer.keys.length - 1)];

    const dur = Math.max(1, layer.durationMs);
    const reps = Math.max(1, layer.repeat || 1);
    const local = this.renderTime() - layer.startMs;
    if (local < 0) return sorted[0];
    if (local >= dur * reps) return sorted[sorted.length - 1];

    const cycle = Math.floor(local / dur);
    let u = (local - cycle * dur) / dur;
    if (layer.pingpong && cycle % 2 === 1) u = 1 - u;

    const tol = (msPerFrame(this.project) / 2) / dur;
    for (let i = 0; i < layer.keys.length; i++) {
      if (Math.abs(layer.keys[i].t - u) <= tol) {
        this.selectedKeyIndex = i;
        return layer.keys[i];
      }
    }
    const fresh = makeKey(u, stateAt(layer, u));
    layer.keys.push(fresh);
    layer.keys.sort((a, b) => a.t - b.t);
    invalidateKeys(layer);
    this.selectedKeyIndex = layer.keys.indexOf(fresh);
    return fresh;
  }

  // ------------------------------------------------------------ edits

  onProjectEdit(opts = {}) {
    this.requestDraw();
    if (!opts.light) this.rebuildHeads();
  }

  refreshInspector() { this.inspector.refresh(); }

  /**
   * Record a snapshot, taken BEFORE the change is applied.
   *
   * Continuous controls (sliders, colour pickers) fire on every input event,
   * which would bury the stack in near-identical entries. Passing a `key`
   * coalesces a run of edits to the same control into one entry: the first
   * call snapshots, later calls only extend the window. A pause longer than
   * COALESCE_MS, or touching a different control, starts a new entry.
   */
  pushUndo(label, key) {
    const now = performance.now();
    if (key && this.undoKey === key && now - this.undoAt < COALESCE_MS) {
      this.undoAt = now;
      return;
    }
    this.undoStack.push({
      label,
      project: serialiseProject(this.project),
      selectedLayerId: this.selectedLayerId,
      selectedKeyIndex: this.selectedKeyIndex,
    });
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    this.undoKey = key || null;
    this.undoAt = now;
  }

  /** Force the next edit to start a fresh undo entry. */
  endUndoGesture() {
    this.undoKey = null;
  }

  applySnapshot(snap) {
    this.project = normaliseProject(snap.project);
    this.selectedLayerId = snap.selectedLayerId;
    this.selectedKeyIndex = snap.selectedKeyIndex;
    $('#showName').value = this.project.name;
    this.renderer.resize(this.project.aspect);
    this.stage.fit();
    this.rebuildHeads();
    this.inspector.refresh();
    this.requestDraw();
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) { status('Nothing to undo'); return; }
    this.redoStack.push({
      label: snap.label,
      project: serialiseProject(this.project),
      selectedLayerId: this.selectedLayerId,
      selectedKeyIndex: this.selectedKeyIndex,
    });
    this.applySnapshot(snap);
    this.endUndoGesture();
    status('Undo: ' + snap.label);
  }

  redo() {
    const snap = this.redoStack.pop();
    if (!snap) { status('Nothing to redo'); return; }
    this.undoStack.push({
      label: snap.label,
      project: serialiseProject(this.project),
      selectedLayerId: this.selectedLayerId,
      selectedKeyIndex: this.selectedKeyIndex,
    });
    this.applySnapshot(snap);
    this.endUndoGesture();
    status('Redo: ' + snap.label);
  }

  // ------------------------------------------------------------ layers

  addLayer(layer) {
    this.pushUndo('add layer');
    layer.startMs = Math.round(this.timeMs / this.snapMs()) * this.snapMs();
    this.project.layers.push(layer);
    this.selectedLayerId = layer.id;
    this.selectedKeyIndex = 0;
    this.rebuildHeads();
    this.inspector.refresh();
    this.requestDraw();
    status(`Added "${layer.name}"`, 'ok');
  }

  duplicateLayer() {
    const layer = this.selectedLayer();
    if (!layer) return;
    this.pushUndo('duplicate layer');
    const copy = normaliseProject({ layers: [serialiseProject(layer)] }).layers[0];
    copy.name = layer.name + ' copy';
    copy.startMs = layer.startMs;
    this.project.layers.push(copy);
    this.selectedLayerId = copy.id;
    this.rebuildHeads();
    this.inspector.refresh();
    this.requestDraw();
  }

  deleteLayer() {
    const layer = this.selectedLayer();
    if (!layer) return;
    this.pushUndo('delete layer');
    const i = this.project.layers.indexOf(layer);
    this.project.layers.splice(i, 1);
    const next = this.project.layers[Math.min(i, this.project.layers.length - 1)];
    this.selectedLayerId = next ? next.id : null;
    this.rebuildHeads();
    this.inspector.refresh();
    this.requestDraw();
  }

  moveLayer(from, to) {
    if (from === to || to < 0 || to >= this.project.layers.length) return;
    this.pushUndo('reorder layers');
    const [l] = this.project.layers.splice(from, 1);
    this.project.layers.splice(to, 0, l);
    this.rebuildHeads();
    this.requestDraw();
  }

  rebuildHeads() {
    const empty = $('#emptyState');
    if (empty) empty.classList.toggle('hidden', this.project.layers.length > 0);
    const heads = clear($('#heads'));
    this.project.layers.forEach((layer, i) => {
      const swatch = el('span', { class: 'swatch' });
      swatch.style.background = layer.kind === 'pattern' && layer.pattern
        ? layer.pattern.color
        : (layer.keys.length ? layer.keys[0].color : '#888');
      const eye = el('button', {
        class: 'eye' + (layer.enabled ? ' on' : ''),
        html: layer.enabled ? '&#9679;' : '&#9675;',
        title: 'Show / hide layer',
        onclick: (e) => {
          e.stopPropagation();
          this.pushUndo('toggle layer');
          layer.enabled = !layer.enabled;
          this.rebuildHeads();
          this.requestDraw();
          this.inspector.refresh();
        },
      });
      const row = el('div', {
        class: 'head' + (layer.id === this.selectedLayerId ? ' sel' : ''),
        draggable: 'true',
        title: layer.name,
        onclick: () => this.selectLayer(layer.id),
      }, [eye, swatch, el('span', { class: 'nm', text: layer.name })]);

      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(i));
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (e) => { e.preventDefault(); });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        this.moveLayer(Number(e.dataTransfer.getData('text/plain')), i);
      });
      heads.appendChild(row);
    });
  }

  // ------------------------------------------------------------ files

  async loadLightMap(name, tagFile, opts = {}) {
    let url = '/api/lightmap?name=' + encodeURIComponent(name);
    if (tagFile) url += '&tags=' + encodeURIComponent(tagFile);
    const data = await api(url);

    // A fresh array identity here is what makes every cached light mapping -
    // tag masks and imported-show light indexes - rebuild against the new map.
    this.lights = data.lights;
    this.tags = data.tags || [];
    this.mapMtime = data.mtime || 0;
    this.tagMtime = data.tagMtime || 0;
    this.setMapStale(false);
    this.project.lightMap = name;
    this.project.tagFile = data.tagFile || '';
    $('#lightMap').value = name;
    $('#tagFile').value = this.project.tagFile;

    const tagged = data.taggedLights || 0;
    $('#lightCount').textContent = tagged
      ? `${this.lights.length} lights, ${this.tags.length} tags`
      : `${this.lights.length} lights`;

    if (opts.remember !== false) {
      this.saveConfig({ lightMap: name, tagFile: this.project.tagFile });
    }
    this.requestDraw();
    this.inspector.refresh();
  }

  /**
   * The light map is read once and held in memory, so editing the yaml on disk
   * would otherwise go unnoticed and silently export against a stale map.
   */
  async checkMapFreshness() {
    if (!this.project.lightMap) return;
    try {
      let url = '/api/lightmap-stat?name=' + encodeURIComponent(this.project.lightMap);
      if (this.project.tagFile) url += '&tags=' + encodeURIComponent(this.project.tagFile);
      const s = await api(url);
      const changed = (s.mtime && s.mtime !== this.mapMtime)
                   || (s.tagMtime && s.tagMtime !== this.tagMtime);
      if (changed && !this.mapStale) {
        this.setMapStale(true);
        status('The light map changed on disk. Click the reload button to pick it up.', 'err');
      }
    } catch (err) { /* freshness is best-effort */ }
  }

  setMapStale(stale) {
    this.mapStale = stale;
    const btn = $('#btnReloadMap');
    if (btn) {
      btn.classList.toggle('stale', stale);
      btn.title = stale
        ? 'The light map changed on disk - click to reload'
        : 'Reload the light map and tags from disk';
    }
    const count = $('#lightCount');
    if (count) count.classList.toggle('stale', stale);
  }

  async reloadLightMap() {
    try {
      await this.loadLightMap(this.project.lightMap, this.project.tagFile || null,
        { remember: false });
      status(`Reloaded ${this.project.lightMap} - ${this.lights.length} lights, `
        + `${this.tags.length} tags`, 'ok');
    } catch (err) {
      status('Reload failed: ' + err.message, 'err');
    }
  }

  rebuildTagFileSelect() {
    const sel = $('#tagFile');
    clear(sel);
    sel.appendChild(el('option', { value: '', text: '(none)' }));
    for (const t of this.tagFiles || []) sel.appendChild(el('option', { value: t, text: t }));
    sel.value = this.project.tagFile || '';
  }

  /** Destinations the export can write to: exports/, plus known machines. */
  async loadFolders() {
    try {
      this.folders = await api('/api/folders');
    } catch (err) {
      this.folders = { folders: [], discovered: [], exportsDir: '', target: 'exports' };
    }
  }

  /** Current export destination as a single value: 'exports' or a folder path. */
  destination() {
    if ((this.config.exportTarget || 'exports') !== 'machine') return 'exports';
    return this.config.machineFolder || 'exports';
  }

  async setDestination(value) {
    try {
      if (value === 'exports') {
        await this.saveConfig({ exportTarget: 'exports' });
      } else {
        // adding is idempotent, and it also selects the folder
        const res = await apiPost('/api/folders', { add: value });
        this.config = await api('/api/config');
        this.folders.folders = res.folders.map((p) => ({ path: p, ok: true }));
        await this.loadFolders();
      }
      this.inspector.refresh();
      status(value === 'exports' ? 'Writing to the exports folder'
        : `Writing to ${this.config.machineShowsDir || value}`, 'ok');
    } catch (err) {
      status(err.message, 'err');
      this.inspector.refresh();
    }
  }

  async forgetFolder(path) {
    try {
      await apiPost('/api/folders', { remove: path });
      this.config = await api('/api/config');
      await this.loadFolders();
      this.inspector.refresh();
      status('Folder removed from the list', 'ok');
    } catch (err) {
      status(err.message, 'err');
    }
  }

  /** Persist part of the workspace so it comes back next launch. */
  async saveConfig(patch) {
    try {
      this.config = await apiPost('/api/config', patch);
    } catch (err) {
      status('Could not save settings: ' + err.message, 'err');
    }
  }

  /** A layer's interpolated state at the playhead, for panels that show it. */
  stateForLayer(layer) {
    return layerStateAtTime(layer, this.renderTime()) || stateAt(layer, 0);
  }

  /** How many lights a layer's tag filter currently selects. */
  countTargeted(layer) {
    const mask = layerMask(layer, this.lights);
    if (!mask) return this.lights.length;
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    return n;
  }

  /** Lights the selected layer may touch, or null when it is unrestricted. */
  targetHighlight() {
    const layer = this.selectedLayer();
    if (!layer || !layer.target || layer.target.mode !== 'tags') return null;
    if (!(layer.target.tags || []).length) return null;
    return layerMask(layer, this.lights);
  }

  /**
   * Rescale every layer so the whole show lasts `targetMs`.
   * Keeps the composition intact; only the time axis changes.
   */
  scaleShowToLength(targetMs) {
    const current = projectDuration(this.project);
    if (!(current > 0) || !(targetMs > 0)) return;
    const k = targetMs / current;
    this.pushUndo('scale show length');
    for (const l of this.project.layers) {
      l.startMs = Math.round(l.startMs * k);
      l.durationMs = Math.max(16, Math.round(l.durationMs * k));
    }
    if (this.project.durationMs > 0) this.project.durationMs = Math.round(targetMs);
    this.timeMs = Math.min(this.timeMs, projectDuration(this.project));
    this.rebuildHeads();
    this.inspector.refresh();
    this.requestDraw();
    status(`Show scaled to ${Math.round(targetMs)} ms`, 'ok');
  }

  /**
   * Export the show at a range of sample rates and report what each costs.
   * Measured rather than estimated: how much a higher rate costs depends
   * entirely on how much the lights actually change.
   */
  async analyseRates() {
    if (!this.lights.length) { status('No lights loaded', 'err'); return; }
    const wasPlaying = this.playing;
    this.setPlaying(false);

    const rates = [10, 15, 20, 24, 30, 40, 50, 60];
    const bar = el('i');
    const label = el('div', { class: 'hint', text: 'Measuring...' });
    showModal('Sample rate', el('div', {}, [label, el('div', { class: 'progress' }, [bar])]), []);

    const rows = [];
    try {
      for (let i = 0; i < rates.length; i++) {
        label.textContent = `Measuring ${rates[i]} Hz...`;
        bar.style.width = ((i / rates.length) * 100).toFixed(0) + '%';
        await new Promise((r) => setTimeout(r, 0));
        const probe = Object.assign({}, this.project, { fps: rates[i] });
        const res = await buildShow(probe, this.lights, this.renderer, null);
        rows.push({ hz: rates[i], frames: res.stats.frames, steps: res.stats.steps,
          kB: res.yaml.length / 1024 });
      }
    } catch (err) {
      hideModal();
      status('Measurement failed: ' + err.message, 'err');
      return;
    }

    const current = this.project.fps;
    const maxSteps = Math.max(...rows.map((r) => r.steps));
    const body = el('div');
    body.appendChild(el('div', { class: 'hint', text:
      'Every rate below plays for the same length of time - the durations are '
      + 'written into the file. A higher rate only buys smoother motion.' }));

    const table = el('div', { class: 'rate-table' });
    table.appendChild(el('div', { class: 'rate-head', text: 'Rate' }));
    table.appendChild(el('div', { class: 'rate-head', text: 'Steps' }));
    table.appendChild(el('div', { class: 'rate-head', text: 'Size' }));
    table.appendChild(el('div', { class: 'rate-head', text: '' }));
    for (const r of rows) {
      const isCur = r.hz === current;
      table.appendChild(el('div', { class: 'rate-cell' + (isCur ? ' cur' : ''), text: r.hz + ' Hz' }));
      table.appendChild(el('div', { class: 'rate-cell' + (isCur ? ' cur' : ''), text: String(r.steps) }));
      table.appendChild(el('div', { class: 'rate-cell' + (isCur ? ' cur' : ''), text: r.kB.toFixed(1) + ' kB' }));
      const barCell = el('div', { class: 'rate-cell' + (isCur ? ' cur' : '') });
      const fill = el('span', { class: 'rate-bar' });
      fill.style.width = Math.max(2, (r.steps / maxSteps) * 100) + '%';
      barCell.appendChild(fill);
      barCell.appendChild(el('button', { class: 'btn small', text: isCur ? 'current' : 'use',
        onclick: () => {
          if (isCur) return;
          this.pushUndo('sample rate');
          this.project.fps = r.hz;
          this.inspector.refresh();
          this.requestDraw();
          hideModal();
          status(`Sample rate set to ${r.hz} Hz`, 'ok');
        } }));
      table.appendChild(barCell);
    }
    body.appendChild(table);

    // Under-sampling shows up as step count still climbing steeply with rate.
    const at = (hz) => rows.find((r) => r.hz === hz);
    const cur = at(current) || rows[0];
    const dbl = at(Math.min(60, current * 2));
    if (dbl && cur.steps > 0 && dbl.steps > cur.steps * 1.6) {
      body.appendChild(el('div', { class: 'hint', text:
        `Doubling to ${dbl.hz} Hz finds ${dbl.steps - cur.steps} more steps, so `
        + `${current} Hz is missing detail your show actually contains. Fast blinks `
        + 'can disappear entirely if the rate is too low.' }));
    } else {
      body.appendChild(el('div', { class: 'hint', text:
        `${current} Hz captures this show well - a higher rate mostly adds file `
        + 'size rather than detail.' }));
    }

    showModal('Sample rate', body, [button('Close', () => {
      hideModal();
      if (wasPlaying) this.setPlaying(true);
    })]);
  }

  // ------------------------------------------------------------ background

  setBackground(name, opts = {}) {
    if (opts.undo !== false) this.pushUndo(name ? 'set playfield image' : 'remove playfield image');
    if (!name) {
      this.project.background = null;
      this.backgroundImage = null;
    } else {
      const prev = this.project.background || {};
      this.project.background = {
        name,
        opacity: prev.opacity == null ? 0.5 : prev.opacity,
        visible: prev.visible !== false,
      };
      const img = new Image();
      img.onload = () => this.requestDraw();
      img.src = '/backgrounds/' + encodeURIComponent(name);
      this.backgroundImage = img;
    }
    if (opts.remember !== false) this.saveConfig({ background: name || '' });
    this.requestDraw();
    this.inspector.refresh();
  }

  importBackground() {
    const input = el('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        const safe = file.name.replace(/[^A-Za-z0-9 ._()-]/g, '_');
        const res = await apiPost('/api/background-import', { name: safe, content: btoa(bin) });
        this.setBackground(res.name);
        status(`Background ${res.name} loaded (${(res.bytes / 1024).toFixed(0)} kB)`, 'ok');
      } catch (err) {
        status('Background import failed: ' + err.message, 'err');
      }
    });
    input.click();
  }

  importTagFile() {
    const input = el('input', { type: 'file', accept: '.yaml,.yml' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const res = await apiPost('/api/tagfile-import', {
          name: file.name.replace(/[^A-Za-z0-9 ._()-]/g, '_'),
          content: await file.text(),
        });
        this.tagFiles = (await api('/api/tagfiles')).tagfiles || [];
        this.rebuildTagFileSelect();
        await this.loadLightMap(this.project.lightMap, res.name);
        status(`Tags loaded from ${res.name} (${res.lights} lights)`, 'ok');
      } catch (err) {
        status('Tag import failed: ' + err.message, 'err');
      }
    });
    input.click();
  }

  // ------------------------------------------------------------ show import

  async importShowDialog() {
    let files = [];
    try { files = (await api('/api/showfiles')).files || []; } catch (err) { /* reported below */ }

    const body = el('div');
    body.appendChild(el('div', { class: 'hint', text:
      'Bring an existing MPF show in as a layer. It drives the lights it names, '
      + 'so you can stack it with shapes, retime it, or fade it in and out.' }));

    const upload = button('Choose a .yaml file...', () => {
      const input = el('input', { type: 'file', accept: '.yaml,.yml' });
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const data = await apiPost('/api/showfile-import', {
            name: file.name.replace(/[^A-Za-z0-9 ._()-]/g, '_'),
            content: await file.text(),
          });
          this.addShowLayer(data);
          hideModal();
        } catch (err) {
          status('Show import failed: ' + err.message, 'err');
        }
      });
      input.click();
    }, 'primary');
    body.appendChild(el('div', { class: 'btn-row' }, [upload]));

    if (files.length) {
      body.appendChild(el('div', { class: 'sec', text: 'Already on disk' }));
      const list = el('div', { class: 'file-list' });
      for (const f of files) {
        list.appendChild(el('div', {
          class: 'file-row',
          onclick: async () => {
            try {
              const data = await api('/api/showfile?source=' + encodeURIComponent(f.source)
                + '&name=' + encodeURIComponent(f.name));
              this.addShowLayer(data);
              hideModal();
            } catch (err) {
              status('Could not read that show: ' + err.message, 'err');
            }
          },
        }, [
          el('span', { class: 'grow', text: f.name }),
          el('span', { class: 'muted', text: f.source }),
        ]));
      }
      body.appendChild(list);
    }
    showModal('Import an MPF show', body, [button('Cancel', hideModal)]);
  }

  addShowLayer(data) {
    const layer = makeShowLayer(data, this.project.fps, this.lights, this.project.lightMap);
    this.addLayer(layer);
    const names = data.lightNames || [];
    const matched = names.filter((n) => this.lights.some((l) => l.name === n)).length;
    if (matched < names.length) {
      status(`Imported ${data.name}: ${matched} of ${names.length} lights matched this map`,
        matched === 0 ? 'err' : '');
    } else {
      status(`Imported ${data.name}: ${names.length} lights, ${data.frames} frames`, 'ok');
    }
    if ((data.warnings || []).length) console.warn('show import warnings', data.warnings);
  }

  importLightMap() {
    const input = el('input', { type: 'file', accept: '.yaml,.yml' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await apiPost('/api/lightmap-import', { name: file.name, content: text });
        const sel = $('#lightMap');
        if (!Array.from(sel.options).some((o) => o.value === res.name)) {
          sel.appendChild(el('option', { value: res.name, text: res.name }));
        }
        sel.value = res.name;
        await this.loadLightMap(res.name);
        status(`Imported ${res.name} - ${res.lights.length} lights`, 'ok');
      } catch (err) {
        status('Import failed: ' + err.message, 'err');
      }
    });
    input.click();
  }

  async save() {
    const name = ($('#showName').value || 'untitled').trim();
    this.project.name = name;
    try {
      const res = await apiPost('/api/show', {
        name: suggestFilename(name).replace(/\.yaml$/, '.json'),
        project: serialiseProject(this.project),
      });
      this.savedName = res.name;
      status(`Saved ${res.name}`, 'ok');
    } catch (err) {
      status('Save failed: ' + err.message, 'err');
    }
  }

  async openDialog() {
    let list = [];
    try { list = (await api('/api/shows')).shows; } catch (err) { /* shown below */ }
    const body = el('div', { class: 'file-list' });
    if (!list.length) {
      body.appendChild(el('div', { class: 'empty', text: 'No saved shows yet.' }));
    }
    for (const name of list) {
      body.appendChild(el('div', {
        class: 'file-row',
        onclick: async () => {
          try {
            const res = await api('/api/show?name=' + encodeURIComponent(name));
            this.pushUndo('open show');
            this.project = normaliseProject(res.project);
            this.savedName = name;
            $('#showName').value = this.project.name;
            if (this.project.lightMap && $('#lightMap').value !== this.project.lightMap) {
              $('#lightMap').value = this.project.lightMap;
              await this.loadLightMap(this.project.lightMap).catch(() => {});
            }
            this.selectedLayerId = this.project.layers.length ? this.project.layers[0].id : null;
            this.selectedKeyIndex = 0;
            this.timeMs = 0;
            this.onAspectChange();
            this.rebuildHeads();
            this.inspector.refresh();
            hideModal();
            status(`Opened ${name}`, 'ok');
          } catch (err) {
            status('Open failed: ' + err.message, 'err');
          }
        },
      }, [el('span', { class: 'grow', text: name })]));
    }
    showModal('Open show', body, [button('Close', hideModal)]);
  }

  newShow() {
    this.pushUndo('new show');
    this.project = makeProject();
    this.project.lightMap = $('#lightMap').value;
    this.savedName = null;
    this.timeMs = 0;
    $('#showName').value = this.project.name;
    this.selectedLayerId = null;          // a new show starts with no layers
    this.selectedKeyIndex = 0;
    this.onAspectChange();
    this.rebuildHeads();
    this.inspector.refresh();
  }

  // ------------------------------------------------------------ presets

  /** First stop when adding a layer: pick how you want to build it. */
  addLayerDialog() {
    const card = (title, blurb, onClick, primary) => el('button', {
      class: 'add-card' + (primary ? ' primary' : ''),
      onclick: () => { hideModal(); onClick(); },
    }, [
      el('div', { class: 'add-card-title', text: title }),
      el('div', { class: 'add-card-blurb', text: blurb }),
    ]);

    const body = el('div', { class: 'add-cards' }, [
      card('Build it step by step',
        'Seven quick steps with a live preview. Best if you are not sure what you want yet.',
        () => this.openWizard(), true),
      card('Start from a preset',
        'Sweeps, spins, chases, blinks and sparkles you can drop in and adjust.',
        () => this.presetDialog()),
      card('From my effects library',
        'Anything you have saved before, dropped in at the playhead.',
        () => this.effectsDialog()),
      card('Import an MPF show',
        'Bring in a show you already have and stack it with new layers.',
        () => this.importShowDialog()),
      card('Surprise me',
        'Add one random layer at the playhead. Roll again for another, or undo.',
        () => this.randomLayer()),
    ]);
    showModal('Add a layer', body, [button('Cancel', hideModal)]);
  }

  presetDialog() {
    const body = el('div');
    let colour = PRESET_COLOURS[0];

    const swatches = el('div', { class: 'btn-row' });
    const chips = PRESET_COLOURS.map((c) => {
      const chip = el('button', { class: 'btn small', title: c });
      chip.style.background = c;
      chip.style.width = '26px';
      chip.style.height = '22px';
      chip.addEventListener('click', () => {
        colour = c;
        chips.forEach((x) => { x.style.outline = 'none'; });
        chip.style.outline = '2px solid #fff';
      });
      swatches.appendChild(chip);
      return chip;
    });
    chips[0].style.outline = '2px solid #fff';
    body.appendChild(el('div', { class: 'sec', text: 'Colour' }));
    body.appendChild(swatches);

    const groups = new Map();
    for (const p of PRESETS) {
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group).push(p);
    }
    for (const [group, items] of groups) {
      body.appendChild(el('div', { class: 'sec', text: group }));
      const grid = el('div', { class: 'shape-grid' });
      grid.style.gridTemplateColumns = 'repeat(5, 1fr)';
      for (const p of items) {
        const sample = p.build('#8fd8ff');
        const icon = p.pattern
          ? patternThumb(sample.pattern)
          : shapeThumb(sample.shapeId, sample.shapeParams);
        grid.appendChild(el('button', {
          class: 'shape-btn',
          title: p.name,
          onclick: () => { this.addLayer(p.build(colour)); hideModal(); },
        }, [icon, el('span', { text: p.name })]));
      }
      body.appendChild(grid);
    }
    showModal('Start from a preset', body, [
      button('Back', () => { hideModal(); this.addLayerDialog(); }),
      button('Cancel', hideModal),
    ]);
  }

  preloadImage(name) { loadShapeImage(name); this.requestDraw(); }

  /** Step-by-step layer builder. */
  openWizard() {
    if (!this.wizard) this.wizard = new Wizard(this);
    this.wizard.open();
  }

  // ------------------------------------------------------------ effects

  /** Save the selected layer, or the whole show, as a reusable effect. */
  saveEffectDialog(allLayers) {
    const layers = allLayers ? this.project.layers : [this.selectedLayer()].filter(Boolean);
    if (!layers.length) { status('Nothing to save', 'err'); return; }

    const suggested = allLayers
      ? (this.project.name || 'Show')
      : layers[0].name;
    const nameInput = el('input', { type: 'text', value: suggested });

    const body = el('div', {}, [
      el('div', { class: 'hint', text:
        `Saving ${layers.length} layer${layers.length === 1 ? '' : 's'}. Everything comes `
        + 'with it: shape, animated parameters, keyframes, pattern settings and tag targets.' }),
      field('Name', nameInput),
    ]);

    const doSave = async (overwrite) => {
      const raw = nameInput.value.trim();
      if (!raw) { status('Give the effect a name', 'err'); return; }
      const file = raw.replace(/[^A-Za-z0-9 ._()-]/g, '_') + '.json';
      try {
        const effect = makeEffect(raw, layers, this.project);
        const res = await saveEffect(file, effect, overwrite);
        if (res.exists && !overwrite) {
          const ok = await confirmModal('Effect already exists',
            `"${raw}" already exists. Replace it?`);
          if (!ok) { status('Not saved', 'err'); return; }
          return doSave(true);
        }
        hideModal();
        status(`Saved effect "${raw}"`, 'ok');
      } catch (err) {
        status('Could not save: ' + err.message, 'err');
      }
    };

    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(false); });
    showModal('Save as effect', body, [
      button('Cancel', hideModal),
      button('Save', () => doSave(false), 'primary'),
    ]);
    nameInput.focus();
    nameInput.select();
  }

  /** Insert a saved effect at the playhead. */
  async insertEffect(file) {
    try {
      const effect = await loadEffect(file);
      const layers = instantiate(effect, Math.round(this.renderTime()));
      if (!layers.length) { status('That effect has no layers', 'err'); return; }

      this.pushUndo('insert effect');
      this.project.layers.push(...layers);
      this.selectedLayerId = layers[0].id;
      this.selectedKeyIndex = 0;
      this.rebuildHeads();
      this.inspector.refresh();
      this.requestDraw();

      const cov = tagCoverage(effect, this.tags);
      if (!cov.ok) {
        status(`Inserted "${effect.name}", but ${cov.missing.length} tag`
          + `${cov.missing.length === 1 ? '' : 's'} are not in this light map: `
          + cov.missing.slice(0, 4).join(', ')
          + ' - those layers will drive nothing until you retarget them.', 'err');
      } else {
        status(`Inserted "${effect.name}" (${layers.length} layer`
          + `${layers.length === 1 ? '' : 's'}) at ${Math.round(this.renderTime())} ms`, 'ok');
      }
    } catch (err) {
      status('Could not insert: ' + err.message, 'err');
    }
  }

  /** Browser for saved effects, with insert and delete. */
  async effectsDialog() {
    let effects = [];
    try { effects = await listEffects(); } catch (err) { /* shown below */ }

    const body = el('div');
    if (!effects.length) {
      body.appendChild(el('div', { class: 'empty', text:
        'No saved effects yet. Build a layer you like, then use "Save as effect" '
        + 'on the Layer tab.' }));
    } else {
      body.appendChild(el('div', { class: 'hint', text:
        `Inserted at the playhead (${Math.round(this.renderTime())} ms), keeping each `
        + 'effect\'s internal timing.' }));
      const list = el('div', { class: 'file-list' });
      for (const e of effects) {
        const cov = tagCoverage({ layers: [{ target: { tags: e.tags } }] }, this.tags);
        const sw = el('span', { class: 'swatch' });
        sw.style.background = e.colour || '#4fc3f7';
        const meta = `${e.layers} layer${e.layers === 1 ? '' : 's'}`
          + (e.durationMs ? ` · ${Math.round(e.durationMs)} ms` : '')
          + (e.tags.length ? ` · ${e.tags.join(', ')}` : '');
        const row = el('div', { class: 'file-row' }, [
          sw,
          el('span', { class: 'grow' }, [
            el('div', { text: e.name }),
            el('div', { class: 'muted', style: 'font-size:11px', text: meta }),
          ]),
          cov.ok ? null : el('span', { class: 'muted', title: 'tags missing here', text: '⚠' }),
          button('Insert', (ev) => {
            ev.stopPropagation();
            hideModal();
            this.insertEffect(e.file);
          }, 'small primary'),
          button('×', async (ev) => {
            ev.stopPropagation();
            const ok = await confirmModal('Delete effect',
              `Delete "${e.name}" permanently?`, 'Delete');
            if (!ok) { this.effectsDialog(); return; }
            await deleteEffect(e.file);
            status(`Deleted "${e.name}"`, 'ok');
            this.effectsDialog();
          }, 'small danger'),
        ]);
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    showModal('Effects library', body, [
      button('Save current layer...', () => { hideModal(); this.saveEffectDialog(false); }),
      button('Close', hideModal),
    ]);
  }

  // ------------------------------------------------------------ random show

  /**
   * Throw together a show from the preset library, then vary it: random
   * colours, paths, sizes, start times and tag targets. Meant as a starting
   * point to edit, not a finished piece.
   */
  randomLayer(opts = {}) {
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    const tagNames = this.tags.map((t) => t.tag).filter((t) => t !== 'all');

    const preset = pick(PRESETS.filter((p) => p.id !== 'blank'));
    const layer = preset.build(pick(PRESET_COLOURS));

    // addLayer drops it at the playhead; we just choose how long it runs
    layer.durationMs = Math.max(200, Math.round(rand(600, 3000) / 50) * 50);

    // a third of the time, aim it at a tag instead of everything
    if (tagNames.length && Math.random() < 0.34) {
      layer.target = {
        mode: 'tags', tags: [pick(tagNames)], match: 'any', invert: false, exclude: [],
      };
    }

    if (layer.kind === 'shape') {
      if (Math.random() < 0.5) {
        const p = pick(PATHS.filter((x) => x.id !== 'none'));
        applyPath(layer, p.id, {
          aspect: this.project.aspect || 0.5,
          cx: rand(0.3, 0.7), cy: rand(0.3, 0.7), r: rand(0.2, 0.5),
          rotate: rand(0, Math.PI * 2), turns: 1 + Math.floor(rand(1, 4)),
          stretch: rand(0.8, 2.6),
          points: p.id === 'diagonal' || p.id === 'sweep-up' ? 2 : 24,
        });
      } else if (Math.random() < 0.7) {
        randomStart(layer);
        randomEnd(layer);
      }
      if (Math.random() < 0.4) pick(TRANSFORMS).apply(layer);
      if (Math.random() < 0.5) applySize(layer, pick(SIZE_PRESETS).scale, true);
    }

    layer.name = `${preset.name} ${this.project.layers.length + 1}`;
    this.addLayer(layer);   // this also statuses and selects
    status(`Rolled "${layer.name}". Roll again for another, or undo.`, 'ok');
    return layer;
  }

  // ------------------------------------------------------------ export

  async doExport() {
    if (!this.lights.length) { status('No lights loaded - pick a light map first', 'err'); return; }
    const wasPlaying = this.playing;
    this.setPlaying(false);

    const bar = el('i');
    const label = el('div', { class: 'hint', text: 'Rendering…' });
    const body = el('div', {}, [label, el('div', { class: 'progress' }, [bar])]);
    showModal('Exporting show', body, []);

    let result;
    try {
      result = await buildShow(this.project, this.lights, this.renderer, (done, total) => {
        bar.style.width = ((done / total) * 100).toFixed(1) + '%';
        label.textContent = `Rendering frame ${done} of ${total}…`;
      });
    } catch (err) {
      hideModal();
      status('Export failed: ' + err.message, 'err');
      return;
    }

    const s = result.stats;
    const filename = suggestFilename(this.project.name);
    const nameInput = el('input', { type: 'text', value: filename });

    const preview = el('pre', { text: result.yaml.split('\n').slice(0, 400).join('\n') });
    if (s.trimmedHead) {
      body2.appendChild(el('div', { class: 'warn',
        text: `Heads up: ${s.trimmedHead} dark frame`
          + `${s.trimmedHead === 1 ? '' : 's'} were trimmed from the start, so every `
          + `cue now happens ${s.headShiftMs} ms earlier than on the timeline. `
          + 'Turn off "Trim dark frames at the start" if this show is cut to audio or video.' }));
    }
    const trimmed = (s.trimmedHead || 0) + (s.trimmedTail || 0);
    const info = el('div', { class: 'stat-grid' }, [
      el('span', { text: 'Steps' }), el('span', { text: `${s.frames} (${s.changedFrames} with changes, ${s.idleFrames} idle)` }),
      el('span', { text: 'Trimmed' }), el('span', { text: trimmed ? `${trimmed} dark frames (${s.trimmedHead} head, ${s.trimmedTail} tail)` : 'none' }),
      el('span', { text: 'Length' }), el('span', { text: `${Math.round(s.frames * 1000 / s.fps)} ms @ ${s.fps} fps` }),
      el('span', { text: 'Lights used' }), el('span', { text: `${s.lightsTouched} of ${s.totalLights}` }),
      el('span', { text: 'Size' }), el('span', { text: `${(result.yaml.length / 1024).toFixed(1)} kB` }),
    ]);

    const body2 = el('div', {}, [
      info,
      el('div', { class: 'sec', text: 'File name' }),
      nameInput,
      el('div', { class: 'sec', text: 'Preview (first 400 lines)' }),
      preview,
    ]);

    const target = this.config.exportTarget || 'exports';
    const machineReady = target === 'machine' && this.config.machineOk;
    const where = machineReady ? this.config.machineShowsDir
      : (this.config.exportsDir || 'exports folder');

    const write = async (overwrite) => {
      const res = await apiPost('/api/export', {
        name: nameInput.value,
        content: result.yaml,
        target: machineReady ? 'machine' : 'exports',
        overwrite: !!overwrite,
      });
      if (res.exists && !overwrite) {
        const ok = await confirmModal('File already exists',
          `${res.path} already exists. Replace it?`);
        if (!ok) {
          status('Not saved - that file already exists', 'err');
          return;
        }
        return write(true);
      }
      hideModal();
      status(`${res.replaced ? 'Replaced' : 'Wrote'} ${res.path} `
        + `(${(res.bytes / 1024).toFixed(1)} kB)`, 'ok');
    };

    const saveBtn = button(machineReady ? 'Save into machine' : 'Save to exports folder',
      async () => {
        try { await write(false); } catch (err) { status('Write failed: ' + err.message, 'err'); }
      }, 'primary');
    saveBtn.title = 'Writes to ' + where;

    if (target === 'machine' && !machineReady) {  // eslint-disable-line
      body2.appendChild(el('div', { class: 'hint',
        text: 'Machine folder is not set or not reachable - this will go to the '
            + 'exports folder instead. Set it in the Export tab.' }));
    }

    const dlBtn = button('Download', () => {
      const blob = new Blob([result.yaml], { type: 'text/yaml' });
      const a = el('a', { href: URL.createObjectURL(blob), download: nameInput.value });
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    const copyBtn = button('Copy to clipboard', async () => {
      try {
        await navigator.clipboard.writeText(result.yaml);
        status('Copied', 'ok');
      } catch (err) {
        status('Clipboard blocked by the browser', 'err');
      }
    });

    showModal('Export show', body2, [copyBtn, dlBtn, saveBtn, button('Close', () => {
      hideModal();
      if (wasPlaying) this.setPlaying(true);
    })]);
  }

  setHoverInfo(text) { $('#hoverInfo').textContent = text; }

  // ------------------------------------------------------------ wiring

  wireChrome() {
    $('#showName').addEventListener('change', (e) => { this.project.name = e.target.value; });
    $('#lightMap').addEventListener('change', async (e) => {
      try { await this.loadLightMap(e.target.value); } catch (err) { status(err.message, 'err'); }
    });
    $('#tagFile').addEventListener('change', async (e) => {
      try {
        await this.loadLightMap(this.project.lightMap, e.target.value || null);
        const n = this.tags.length;
        status(e.target.value ? `${n} tags available` : 'Tags cleared', 'ok');
      } catch (err) { status(err.message, 'err'); }
    });

    $('#btnReloadMap').onclick = () => this.reloadLightMap();
    $('#btnNew').onclick = () => this.newShow();
    $('#btnOpen').onclick = () => this.openDialog();
    $('#btnSave').onclick = () => this.save();
    $('#btnUndo').onclick = () => this.undo();
    $('#btnRedo').onclick = () => this.redo();
    $('#btnExport').onclick = () => this.doExport();

    $$('.segbtn').forEach((b) => {
      b.onclick = () => {
        $$('.segbtn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this.view = b.dataset.view;
        this.requestDraw();
      };
    });
    $('#tglOff').onchange = (e) => { this.showOff = e.target.checked; this.requestDraw(); };
    $('#tglGlow').onchange = (e) => { this.glow = e.target.checked; this.requestDraw(); };
    $('#tglOnion').onchange = (e) => { this.onion = e.target.checked; this.requestDraw(); };
    $('#tglPath').onchange = (e) => { this.showPath = e.target.checked; this.requestDraw(); };
    $('#rngLightSize').oninput = (e) => { this.lightSize = Number(e.target.value); this.requestDraw(); };

    $('#btnPlay').onclick = () => this.setPlaying(!this.playing);
    $('#btnStart').onclick = () => this.setTime(0);
    $('#btnEnd').onclick = () => this.setTime(projectDuration(this.project));
    $('#btnLoop').onclick = () => {
      this.loop = !this.loop;
      $('#btnLoop').classList.toggle('active', this.loop);
    };
    $('#selSpeed').onchange = (e) => { this.speed = Number(e.target.value); };
    $('#rngZoom').oninput = (e) => this.setZoom(Number(e.target.value));
    $('#tglAutoKey').onchange = (e) => { this.autoKey = e.target.checked; };

    $('#btnAddKey').onclick = () => this.addKeyAtPlayhead();
    $('#btnDelKey').onclick = () => this.deleteSelectedKey();

    $('#btnAddLayer').onclick = () => this.addLayerDialog();
    $('#emptyWizard').onclick = () => this.openWizard();
    $('#emptyPreset').onclick = () => this.presetDialog();
    $('#emptyRandom').onclick = () => this.randomLayer();

    $('#btnEffects').onclick = () => this.effectsDialog();
    $('#btnDupLayer').onclick = () => this.duplicateLayer();
    $('#btnDelLayer').onclick = () => this.deleteLayer();

    $$('.tab').forEach((t) => {
      t.onclick = () => {
        $$('.tab').forEach((x) => x.classList.remove('active'));
        $$('.tab-panel').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        $(`.tab-panel[data-panel="${t.dataset.tab}"]`).classList.add('active');
      };
    });

    $('#modalClose').onclick = hideModal;
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') hideModal(); });
  }

  addKeyAtPlayhead() {
    const layer = this.selectedLayer();
    if (!layer) return;
    this.pushUndo('add keyframe');
    const dur = Math.max(1, layer.durationMs);
    const u = Math.max(0, Math.min(1, (this.renderTime() - layer.startMs) / dur));
    const fresh = makeKey(u, stateAt(layer, u));
    layer.keys.push(fresh);
    layer.keys.sort((a, b) => a.t - b.t);
    invalidateKeys(layer);
    this.selectedKeyIndex = layer.keys.indexOf(fresh);
    this.inspector.refresh();
    this.requestDraw();
  }

  deleteSelectedKey() {
    const layer = this.selectedLayer();
    if (!layer || layer.keys.length <= 1) return;
    this.pushUndo('delete keyframe');
    layer.keys.splice(this.selectedKeyIndex, 1);
    invalidateKeys(layer);
    this.selectedKeyIndex = Math.max(0, this.selectedKeyIndex - 1);
    this.inspector.refresh();
    this.requestDraw();
  }

  wireKeys() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); return; }
      if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); this.addLayerDialog(); return; }
      if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateLayer(); return; }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.setPlaying(!this.playing);
          break;
        case 'Home': this.setTime(0); break;
        case 'End': this.setTime(projectDuration(this.project)); break;
        case 'ArrowLeft': e.preventDefault(); this.stepFrame(e.shiftKey ? -10 : -1); break;
        case 'ArrowRight': e.preventDefault(); this.stepFrame(e.shiftKey ? 10 : 1); break;
        case 'ArrowUp': e.preventDefault(); this.cycleLayer(-1); break;
        case 'ArrowDown': e.preventDefault(); this.cycleLayer(1); break;
        case 'k': case 'K': this.addKeyAtPlayhead(); break;
        case 'Delete': case 'Backspace': this.deleteSelectedKey(); break;
        case '1': this.setView('both'); break;
        case '2': this.setView('shapes'); break;
        case '3': this.setView('lights'); break;
        case 'l': case 'L':
          this.setView(this.view === 'lights' ? 'both' : 'lights');
          break;
        case 'o': case 'O':
          $('#tglOnion').checked = !$('#tglOnion').checked;
          this.onion = $('#tglOnion').checked;
          this.requestDraw();
          break;
        case 'Escape': hideModal(); break;
        default: break;
      }
    });
  }

  setView(v) {
    this.view = v;
    $$('.segbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    this.requestDraw();
  }

  cycleLayer(dir) {
    const layers = this.project.layers;
    if (!layers.length) return;
    const i = layers.findIndex((l) => l.id === this.selectedLayerId);
    const next = layers[(i + dir + layers.length) % layers.length];
    this.selectLayer(next.id);
  }
}

/** Little glyph for a pattern preset, since it has no shape to draw. */
function patternThumb(pattern) {
  const c = document.createElement('canvas');
  c.width = 34; c.height = 34;
  const g = c.getContext('2d');
  g.fillStyle = '#05070a';
  g.fillRect(0, 0, 34, 34);
  g.fillStyle = '#8fd8ff';
  const t = pattern ? pattern.type : 'blink';
  if (t === 'chase') {
    for (let i = 0; i < 5; i++) {
      g.globalAlpha = 1 - i * 0.18;
      g.beginPath();
      g.arc(6 + i * 6, 17, 2.6, 0, Math.PI * 2);
      g.fill();
    }
  } else if (t === 'solid') {
    g.globalAlpha = 1;
    g.beginPath(); g.arc(17, 17, 8, 0, Math.PI * 2); g.fill();
  } else {
    g.globalAlpha = 1;
    g.beginPath(); g.arc(11, 17, 5, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 0.22;
    g.beginPath(); g.arc(24, 17, 5, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  return c;
}

const app = new App();
window.app = app;
app.init();
