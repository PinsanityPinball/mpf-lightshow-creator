// Small DOM helpers. Nothing clever, just less typing.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Labelled row with an arbitrary control. */
export function field(label, control, opts = {}) {
  return el('div', { class: 'field row' + (opts.class ? ' ' + opts.class : '') }, [
    el('label', { text: label, title: opts.title || label }),
    control,
  ]);
}

/** Slider + numeric readout that stay in sync. */
export function slider(label, value, spec, onChange, extra) {
  const val = el('input', {
    class: 'val', type: 'number',
    min: spec.min, max: spec.max, step: spec.step, value: round(value, spec.step),
  });
  const rng = el('input', {
    type: 'range', min: spec.min, max: spec.max, step: spec.step, value,
  });
  const push = (v, from) => {
    v = clamp(Number(v), spec.min, spec.max);
    if (Number.isNaN(v)) return;
    // snap to the step, so a whole-number setting stays a whole number
    if (spec.step) v = Number((Math.round(v / spec.step) * spec.step).toFixed(6));
    if (from !== 'range') rng.value = v;
    if (from !== 'num' || Number(val.value) !== v) val.value = round(v, spec.step);
    onChange(v);
  };
  rng.addEventListener('input', () => push(rng.value, 'range'));
  val.addEventListener('change', () => push(val.value, 'num'));
  const wrap = el('div', {}, [rng, val]);
  const head = extra
    ? el('label', { class: 'with-extra' }, [el('span', { text: label }), extra])
    : el('label', { text: label });
  const root = el('div', { class: 'field slider' }, [head, wrap]);
  root.setValue = (v) => { rng.value = v; val.value = round(v, spec.step); };
  return root;
}

export function selectBox(value, options, onChange, title) {
  const s = el('select', { title: title || '' });
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    s.appendChild(el('option', { value: v, text: label, selected: v === value }));
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'chk' }, [input, ' ' + label]);
}

export function colorInput(value, onChange) {
  const c = el('input', { type: 'color', value });
  c.addEventListener('input', () => onChange(c.value));
  return c;
}

export function button(label, onClick, cls = '') {
  return el('button', { class: 'btn ' + cls, text: label, onclick: onClick });
}

export function section(title) {
  return el('div', { class: 'sec', text: title });
}

export function hint(text) {
  return el('div', { class: 'hint', text });
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function round(v, step) {
  const s = step || 0.01;
  const dp = Math.max(0, Math.ceil(-Math.log10(s)));
  return Number(Number(v).toFixed(dp));
}

export function fmtMs(ms) {
  return Math.round(ms).toLocaleString();
}

// -------------------------------------------------------------- modal

const modal = () => document.getElementById('modal');

export function showModal(title, bodyNode, footNodes = []) {
  const m = modal();
  document.getElementById('modalTitle').textContent = title;
  const body = clear(document.getElementById('modalBody'));
  body.appendChild(bodyNode);
  const foot = clear(document.getElementById('modalFoot'));
  for (const f of footNodes) foot.appendChild(f);
  m.classList.remove('hidden');
  return m;
}

export function hideModal() {
  modal().classList.add('hidden');
}

/** In-app yes/no. Replaces window.confirm, which browsers can suppress. */
export function confirmModal(title, message, confirmLabel = 'Replace') {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; hideModal(); resolve(v); } };
    const body = el('div', {}, [
      el('div', { class: 'hint', style: 'font-size:13px;line-height:1.5', text: message }),
    ]);
    showModal(title, body, [
      button('Cancel', () => done(false)),
      button(confirmLabel, () => done(true), 'primary'),
    ]);
  });
}

let statusTimer = null;
export function status(text, kind = '') {
  const s = document.getElementById('status');
  s.textContent = text;
  s.className = 'status show ' + kind;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { s.className = 'status ' + kind; }, kind === 'err' ? 7000 : 3500);
}

// -------------------------------------------------------------- fetch

export async function api(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json error page */ }
  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  }
  return data;
}

export function apiPost(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A start/end pair of sliders for one value, with a badge that toggles between
 * "static" (both ends equal) and animating across the clip.
 *
 * Lives here rather than in the wizard because the Layer panel offers the same
 * controls; two implementations would drift in behaviour and appearance.
 *
 * @param {Function} [after]  called after each change, for a live preview.
 */
export function rangeRow(label, spec, current, apply, after) {
  const state = { from: current.from, to: current.to };
  // Linked means "one value, both ends". Dragging the start carries the end
  // with it until you move the end yourself.
  let linked = Math.abs(state.from - state.to) < 1e-9;
  const halves = {};

  // Snap to the step so an integer setting like Stripes/Count can only ever
  // be a whole number, however it was reached.
  const snap = (raw) => {
    let v = Number(raw);
    if (!Number.isFinite(v)) return null;
    v = Math.max(spec.min, Math.min(spec.max, v));
    if (spec.step) v = Math.round(v / spec.step) * spec.step;
    return Number(v.toFixed(6));
  };

  const show = (key, v) => {
    const h = halves[key];
    if (!h) return;
    if (document.activeElement !== h.r) h.r.value = v;
    if (document.activeElement !== h.i) h.i.value = round(v, spec.step);
  };

  const mk = (key) => {
    const i = el('input', {
      type: 'number', class: 'val',
      min: spec.min, max: spec.max, step: spec.step, value: round(state[key], spec.step),
    });
    const r = el('input', {
      type: 'range', min: spec.min, max: spec.max, step: spec.step, value: state[key],
    });
    halves[key] = { i, r };

    const push = (raw, src) => {
      const v = snap(raw);
      if (v === null) return;
      state[key] = v;
      if (key === 'to') linked = false;
      if (key === 'from' && linked) { state.to = v; show('to', v); }
      // update the sibling input only, never rebuild the panel: re-rendering
      // here would tear the slider out from under the pointer mid-drag
      if (src !== 'r') r.value = v;
      // also correct the box when its own typed value was snapped
      if (src !== 'n' || Number(i.value) !== v) i.value = round(v, spec.step);
      apply(state.from, state.to);
      if (after) after();
      sync();
    };
    r.addEventListener('input', () => push(r.value, 'r'));
    i.addEventListener('change', () => push(i.value, 'n'));
    return el('div', { class: 'wiz-range-half' }, [r, i]);
  };

  // "Changes over the show" off is the common case, and showing a second
  // slider for it doubled the height of every row for nothing. The end half is
  // hidden until you ask for it.
  const badge = el('button', {
    class: 'anim-btn' + (linked ? '' : ' on'),
    text: 'changes',
    title: linked
      ? 'Off: one value for the whole clip. Turn on to animate it.'
      : 'On: animates from the start value to the end value.',
    onclick: () => {
      if (linked) {
        const mid = (spec.min + spec.max) / 2;
        state.to = snap(state.from <= mid ? spec.max : spec.min);
        linked = false;
      } else {
        state.to = state.from;
        linked = true;
      }
      show('to', state.to);
      apply(state.from, state.to);
      sync();
      if (after) after();
    },
  });

  const fromHalf = mk('from');
  const toHalf = mk('to');
  const startTag = el('span', { class: 'muted', text: 'start' });
  const endTag = el('span', { class: 'muted', text: 'end' });
  const pair = el('div', { class: 'wiz-range-pair' }, [
    startTag, fromHalf, endTag, toHalf,
  ]);

  function sync() {
    badge.className = 'anim-btn' + (linked ? '' : ' on');
    badge.title = linked
      ? 'Off: one value for the whole clip. Turn on to animate it.'
      : 'On: animates from the start value to the end value.';
    // hidden, not removed, so the values survive toggling it back on
    endTag.hidden = linked;
    toHalf.hidden = linked;
    startTag.hidden = linked;    // with no end half, "start" labels nothing
    pair.classList.toggle('single', linked);
  }
  sync();

  return el('div', { class: 'wiz-range' }, [
    el('div', { class: 'wiz-range-label' }, [el('span', { text: label }), badge]),
    pair,
  ]);
}
