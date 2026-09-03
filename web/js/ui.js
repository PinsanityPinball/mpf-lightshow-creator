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
