// Saved reusable effects: take a layer (or a whole show) out of one project and
// drop it into another.
//
// An effect stores complete layers, so shapes, animated parameters, patterns,
// keyframes and tag targets all come back intact. Positions are normalised, so
// shape layers are portable between machines; tag targets and imported-show
// light names are not, and the browser reports coverage before you insert.

import { normaliseProject, nextId, serialiseProject } from './project.js';
import { api, apiPost } from './ui.js';

/**
 * Package layers into an effect.
 * `seedKey` freezes each layer's random identity, so a sparkle saved today
 * looks the same when inserted tomorrow under a fresh layer id.
 */
export function makeEffect(name, layers, project) {
  return {
    name,
    group: 'Saved',
    created: new Date().toISOString().slice(0, 10),
    lightMap: project.lightMap || '',
    tagFile: project.tagFile || '',
    durationMs: Math.max(...layers.map((l) => l.startMs + l.durationMs * Math.max(1, l.repeat || 1)), 0),
    layers: serialiseProject({ layers }).layers.map((l) => Object.assign({}, l, {
      seedKey: l.seedKey || l.id,
    })),
  };
}

export function listEffects() {
  return api('/api/effects').then((d) => d.effects || []);
}

export function loadEffect(file) {
  return api('/api/effect?name=' + encodeURIComponent(file)).then((d) => d.effect);
}

export function saveEffect(name, effect, overwrite) {
  return apiPost('/api/effect', { name, effect, overwrite: !!overwrite });
}

export function deleteEffect(file) {
  return apiPost('/api/effect-delete', { name: file });
}

/**
 * Turn a stored effect into layers ready to append, shifted so the earliest
 * one starts at `atMs` and the rest keep their relative timing.
 */
export function instantiate(effect, atMs) {
  const norm = normaliseProject({ layers: effect.layers || [] });
  const layers = norm.layers;
  if (!layers.length) return [];

  const earliest = Math.min(...layers.map((l) => l.startMs));
  for (const l of layers) {
    l.id = nextId();                       // fresh identity, stable randomness
    l.startMs = Math.max(0, Math.round(l.startMs - earliest + atMs));
  }
  return layers;
}

/** Which of an effect's tag targets exist in the current light map. */
export function tagCoverage(effect, tags) {
  const have = new Set((tags || []).map((t) => t.tag));
  const wanted = new Set();
  for (const l of effect.layers || []) {
    const t = l.target || {};
    for (const tag of t.tags || []) wanted.add(tag);
    for (const tag of t.exclude || []) wanted.add(tag);
  }
  const missing = [...wanted].filter((t) => !have.has(t));
  return { wanted: [...wanted], missing, ok: missing.length === 0 };
}
