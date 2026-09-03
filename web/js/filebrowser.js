/**
 * A small read-only file browser for picking a YAML off the disk.
 *
 * The alternative was making people copy monitor.yaml and lights.yaml into
 * lightmaps/, which means a stale duplicate the moment they edit the real one.
 * Picking in place keeps a single copy: the app stores the absolute path and
 * re-reads it, so the freshness check still notices edits made outside.
 */

import { el, button, showModal, hideModal, api } from './ui.js';

const ICON = { map: '◉', tags: '▤', both: '◈', yaml: '·', show: '▸' };
const KIND_LABEL = { map: 'light map', tags: 'tags', both: 'map + tags', yaml: '', show: 'show' };

/**
 * Open the browser. Resolves to an absolute file path, or null if cancelled.
 *
 * @param {object} opts
 * @param {string} opts.title    heading for the modal
 * @param {string} opts.kind     'map' | 'tags' | 'any' - what to highlight
 * @param {string} opts.mode     'file' (default), 'folder', or 'save'
 * @param {string} opts.defaultName  save mode: the filename to start with
 * @param {string} opts.startAt  folder to open in, if any
 */
export function pickFile(opts = {}) {
  const kind = opts.kind || 'any';
  const folderMode = opts.mode === 'folder';
  // Save mode is folder navigation plus a name: you are choosing where a file
  // will go, so the files already there matter - both to avoid clobbering one
  // by accident and to reuse a name on purpose.
  const saveMode = opts.mode === 'save';
  return new Promise((resolve) => {
    let settled = false;
    let chosen = null;
    const done = (v) => { if (!settled) { settled = true; hideModal(); resolve(v); } };

    const crumbs = el('div', { class: 'fb-crumbs' });
    const list = el('div', { class: 'fb-list' });
    const foot = el('div', { class: 'fb-chosen', text: 'Nothing selected yet.' });

    // save mode: a filename to write, alongside the folder being browsed
    let folderNow = '';
    let takenNow = new Set();
    const nameInput = el('input', {
      class: 'fb-name-input', type: 'text', value: opts.defaultName || '',
      placeholder: 'file name',
    });
    const nameRow = el('div', { class: 'fb-save-row' }, [
      el('label', { text: 'Save as' }), nameInput,
    ]);

    const fullName = () => {
      const n = (nameInput.value || '').trim();
      if (!n) return '';
      return /\.json$/i.test(n) ? n : n + '.json';
    };
    const joined = () => {
      if (!folderNow) return '';
      const sep = folderNow.includes('\\') ? '\\' : '/';
      return folderNow.replace(/[\\/]$/, '') + sep + fullName();
    };

    const useBtn = button(folderMode ? 'Use this folder'
      : (saveMode ? 'Save here' : 'Use this file'),
    () => done(saveMode ? joined() : chosen), 'primary');
    useBtn.disabled = true;

    /** Keep the button honest about what pressing it will do. */
    const refreshSave = () => {
      const n = fullName();
      const clash = !!n && takenNow.has(n.toLowerCase());
      useBtn.disabled = !folderNow || !n;
      useBtn.textContent = clash ? 'Overwrite' : 'Save here';
      useBtn.classList.toggle('danger', clash);
      foot.classList.toggle('on', !!n && !clash);
      foot.classList.toggle('warn', clash);
      foot.textContent = !folderNow ? 'Open the folder you want to save into.'
        : (!n ? 'Give the file a name.'
          : (clash ? 'Replaces the existing ' + n + ' in this folder.' : joined()));
    };
    nameInput.oninput = refreshSave;

    const HINT = {
      map: 'Pick your monitor.yaml. It stays where it is - the app reads it in place. '
        + 'Likely matches are highlighted, but any YAML can be chosen.',
      tags: 'Pick your lights.yaml. It stays where it is - the app reads it in place. '
        + 'Likely matches are highlighted, but any YAML can be chosen.',
      folder: 'Open the folder you want, then use it. Your MPF machine folder is '
        + 'the one containing config/ - shows go into its shows/ subfolder.',
      show: 'Pick a saved show (.json). It stays where it is - saving writes '
        + 'back to the same file, not into the app folder.',
      save: 'Open the folder you want, name the file, and save. The show is '
        + 'then tied to that file: saving again writes straight back to it.',
      any: 'Pick a YAML file.',
    };
    const body = el('div', { class: 'fb' }, [
      el('div', {
        class: 'hint',
        text: saveMode ? HINT.save : (folderMode ? HINT.folder : (HINT[kind] || HINT.any)),
      }),
      crumbs, list, foot,
    ]);
    if (saveMode) body.insertBefore(nameRow, foot);

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

      // In folder mode the folder you are standing in is the thing being picked.
      // "Places" is not a folder, so nothing is selected there - otherwise the
      // button stayed armed with whichever folder you had navigated out of.
      if (saveMode) {
        folderNow = data.path || '';
        takenNow = new Set((data.files || []).map((f) => f.name.toLowerCase()));
        refreshSave();
      }

      if (folderMode) {
        chosen = data.path || null;
        useBtn.disabled = !chosen;
        foot.textContent = chosen || 'Open a folder to choose it.';
        foot.classList.toggle('on', !!chosen);
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
        // In save mode an existing file is a name to reuse, not a file to open:
        // clicking it fills the box so overwriting is deliberate and visible.
        row.onclick = saveMode
          ? () => { nameInput.value = f.name; refreshSave(); }
          : () => { select(f.path, f.name, f.kind); row.classList.add('sel'); };
        row.ondblclick = saveMode ? () => {} : () => done(f.path);
        list.appendChild(row);
      }

      if (!(data.dirs || []).length && (folderMode || !(data.files || []).length)) {
        list.appendChild(el('div', {
          class: 'fb-empty',
          text: data.atRoot ? 'Nothing to show.'
            : (folderMode ? 'No subfolders here. You can still use this folder.'
              : (kind === 'show' ? 'No folders or saved shows here.'
                : 'No folders or YAML files here.')),
        }));
      }
    }

    if (saveMode) refreshSave();
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
