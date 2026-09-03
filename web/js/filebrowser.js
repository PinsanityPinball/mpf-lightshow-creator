/**
 * A small read-only file browser for picking a YAML off the disk.
 *
 * The alternative was making people copy monitor.yaml and lights.yaml into
 * lightmaps/, which means a stale duplicate the moment they edit the real one.
 * Picking in place keeps a single copy: the app stores the absolute path and
 * re-reads it, so the freshness check still notices edits made outside.
 */

import { el, button, showModal, hideModal, api, status } from './ui.js';

const ICON = { map: '◉', tags: '▤', both: '◈', yaml: '·' };
const KIND_LABEL = { map: 'light map', tags: 'tags', both: 'map + tags', yaml: '' };

/**
 * Open the browser. Resolves to an absolute file path, or null if cancelled.
 *
 * @param {object} opts
 * @param {string} opts.title    heading for the modal
 * @param {string} opts.kind     'map' | 'tags' | 'any' - what to highlight
 * @param {string} opts.mode     'file' (default) or 'folder'
 * @param {string} opts.startAt  folder to open in, if any
 */
export function pickFile(opts = {}) {
  const kind = opts.kind || 'any';
  const folderMode = opts.mode === 'folder';
  return new Promise((resolve) => {
    let settled = false;
    let chosen = null;
    const done = (v) => { if (!settled) { settled = true; hideModal(); resolve(v); } };

    const crumbs = el('div', { class: 'fb-crumbs' });
    const list = el('div', { class: 'fb-list' });
    const foot = el('div', { class: 'fb-chosen', text: 'Nothing selected yet.' });
    const useBtn = button(folderMode ? 'Use this folder' : 'Use this file',
      () => done(chosen), 'primary');
    useBtn.disabled = true;

    const HINT = {
      map: 'Pick your monitor.yaml. It stays where it is - the app reads it in place. '
        + 'Likely matches are highlighted, but any YAML can be chosen.',
      tags: 'Pick your lights.yaml. It stays where it is - the app reads it in place. '
        + 'Likely matches are highlighted, but any YAML can be chosen.',
      folder: 'Open the folder you want, then use it. Your MPF machine folder is '
        + 'the one containing config/ - shows go into its shows/ subfolder.',
      any: 'Pick a YAML file.',
    };
    const body = el('div', { class: 'fb' }, [
      el('div', { class: 'hint', text: folderMode ? HINT.folder : (HINT[kind] || HINT.any) }),
      crumbs, list, foot,
    ]);

    const select = (path, name, fileKind) => {
      chosen = path;
      useBtn.disabled = false;
      foot.textContent = `${name}  -  ${path}`;
      foot.classList.add('on');
      for (const n of list.querySelectorAll('.fb-row.sel')) n.classList.remove('sel');
    };

    async function go(path) {
      list.textContent = '';
      list.appendChild(el('div', { class: 'fb-empty', text: 'Reading...' }));
      let data;
      try {
        data = await api('/api/browse?kind=' + encodeURIComponent(kind)
          + '&path=' + encodeURIComponent(path || ''));
      } catch (err) {
        list.textContent = '';
        list.appendChild(el('div', { class: 'fb-empty err', text: err.message }));
        return;
      }

      // breadcrumbs
      crumbs.textContent = '';
      crumbs.appendChild(el('button', {
        class: 'fb-crumb', text: 'Places', onclick: () => go(''),
      }));
      for (const c of data.crumbs || []) {
        crumbs.appendChild(el('span', { class: 'fb-sep', text: '›' }));
        crumbs.appendChild(el('button', {
          class: 'fb-crumb', text: c.name, onclick: () => go(c.path),
        }));
      }

      // in folder mode the folder you are standing in is the thing being picked
      if (folderMode && data.path) {
        chosen = data.path;
        useBtn.disabled = false;
        foot.textContent = data.path;
        foot.classList.add('on');
      }

      list.textContent = '';
      if (data.parent) {
        list.appendChild(el('div', {
          class: 'fb-row up', onclick: () => go(data.parent),
        }, [el('span', { class: 'fb-icon', text: '↑' }),
          el('span', { class: 'fb-name', text: '.. up one level' })]));
      }

      for (const d of data.dirs || []) {
        list.appendChild(el('div', {
          class: 'fb-row dir', onclick: () => go(d.path), title: d.path,
        }, [el('span', { class: 'fb-icon', text: '▸' }),
          el('span', { class: 'fb-name', text: d.name })]));
      }

      for (const f of (folderMode ? [] : data.files || [])) {
        // a file carrying both positions and tags can serve either role
        const suits = f.kind === kind || f.kind === 'both';
        const row = el('div', {
          class: 'fb-row file' + (suits ? ' match' : ''), title: f.path,
        }, [
          el('span', { class: 'fb-icon', text: ICON[f.kind] || ICON.yaml }),
          el('span', { class: 'fb-name', text: f.name }),
          el('span', { class: 'fb-kind', text: KIND_LABEL[f.kind] || '' }),
        ]);
        row.onclick = () => { select(f.path, f.name, f.kind); row.classList.add('sel'); };
        row.ondblclick = () => done(f.path);
        list.appendChild(row);
      }

      if (!(data.dirs || []).length && (folderMode || !(data.files || []).length)) {
        list.appendChild(el('div', {
          class: 'fb-empty',
          text: data.atRoot ? 'Nothing to show.'
            : (folderMode ? 'No subfolders here. You can still use this folder.'
              : 'No folders or YAML files here.'),
        }));
      }
    }

    showModal(opts.title || 'Choose a file', body, [
      button('Cancel', () => done(null)),
      useBtn,
    ]);
    go(opts.startAt || '');
  });
}

/** Last path segment, for showing an absolute path compactly in a dropdown. */
export function baseName(path) {
  const parts = String(path || '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * "monitor.yaml - showcreator": a file name alone is ambiguous in the
 * dropdowns, since the whole point of browsing is reaching files that may share
 * a name with one already in lightmaps/. The parent folder tells them apart.
 */
export function shortPath(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] || path;
  const parent = parts[parts.length - 2];
  return parent ? `${name} - ${parent}` : name;
}

/** True when a dropdown value is an absolute path rather than a bare name. */
export function isAbsolute(value) {
  return /^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(String(value || ''));
}
