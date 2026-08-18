'use strict';

const state = {
  path: '/',
  entries: [],
  selected: new Set(),
};

const rowsEl = document.getElementById('file-rows');
const emptyEl = document.getElementById('empty-state');
const selectAllEl = document.getElementById('select-all');
const deleteBtn = document.getElementById('delete-btn');
const fileInput = document.getElementById('file-input');
const uploadPanel = document.getElementById('upload-panel');
const uploadList = document.getElementById('upload-list');

function joinPath(base, name) {
  return (base === '/' ? '' : base) + '/' + name;
}

function typeTag(entry) {
  if (entry.dir) return 'dir';
  const m = entry.mime || '';
  if (m.startsWith('image/')) return 'img';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/')) return 'txt';
  if (m.startsWith('video/')) return 'vid';
  if (m.startsWith('audio/')) return 'aud';
  if (m.includes('zip') || m.includes('compressed') || m.includes('tar')) return 'arc';
  return 'bin';
}

function previewable(entry) {
  if (entry.dir) return false;
  const m = entry.mime || '';
  return m.startsWith('image/') || m === 'application/pdf' || m.startsWith('text/');
}

function updatePrompt() {
  const parts = state.path.split('/').filter(Boolean);
  const segments = [{
    label: '~',
    onclick: parts.length ? () => load('/') : undefined,
  }];
  parts.forEach((part, i) => {
    const target = '/' + parts.slice(0, i + 1).join('/');
    segments.push({
      label: part,
      onclick: i < parts.length - 1 ? () => load(target) : undefined,
    });
  });
  Shell.setPrompt(segments);
}

function updateDeleteBtn() {
  const n = state.selected.size;
  deleteBtn.disabled = n === 0;
  deleteBtn.textContent = n > 1 ? `Delete (${n})` : 'Delete';
}

function render() {
  rowsEl.textContent = '';
  state.selected.clear();
  selectAllEl.checked = false;
  updateDeleteBtn();
  emptyEl.hidden = state.entries.length > 0;

  for (const entry of state.entries) {
    const full = joinPath(state.path, entry.name);
    const check = el('input', {
      type: 'checkbox', 'aria-label': `Select ${entry.name}`,
      onchange: (e) => {
        if (e.target.checked) state.selected.add(full);
        else state.selected.delete(full);
        selectAllEl.checked = state.selected.size === state.entries.length;
        updateDeleteBtn();
      },
    });

    const nameLink = el('a', {
      class: 'name-link', href: '#',
      onclick: (e) => {
        e.preventDefault();
        if (entry.dir) load(full);
        else if (previewable(entry)) openPreview(entry, full);
        else download(full);
      },
    }, entry.name);

    const actions = [];
    if (previewable(entry)) {
      actions.push(el('button', { class: 'btn-ghost', onclick: () => openPreview(entry, full) }, 'view'));
    }
    if (!entry.dir) {
      actions.push(el('button', { class: 'btn-ghost', onclick: () => download(full) }, 'get'));
    }
    actions.push(el('button', { class: 'btn-ghost', onclick: () => openRename(entry, full) }, 'ren'));
    actions.push(el('button', { class: 'btn-ghost danger', onclick: () => openDelete([full]) }, 'del'));

    rowsEl.append(el('tr', { class: entry.dir ? 'is-dir' : '' },
      el('td', {}, check),
      el('td', {}, nameLink),
      el('td', { class: 'optional' }, el('span', { class: 'tag' + (entry.dir ? ' amber' : '') }, typeTag(entry))),
      el('td', { class: 'num' }, entry.dir ? '—' : fmtBytes(entry.size)),
      el('td', { class: 'num optional' }, fmtDate(entry.mtime)),
      el('td', { class: 'actions' }, el('div', { class: 'row', style: 'flex-wrap: nowrap; justify-content: flex-end;' }, actions))));
  }
}

async function load(path) {
  await withBusy(async () => {
    try {
      const data = await API.call('/api/files/list?path=' + encodeURIComponent(path));
      state.path = data.path;
      state.entries = data.entries;
      Shell.updateGauge(data.usedBytes, data.quotaBytes);
      updatePrompt();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function download(fullPath) {
  // Navigation download keeps the httpOnly cookie flow; no tokens in URLs.
  const a = document.createElement('a');
  a.href = '/api/files/download?path=' + encodeURIComponent(fullPath);
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------- Selection ---------- */

selectAllEl.addEventListener('change', () => {
  state.selected.clear();
  if (selectAllEl.checked) {
    for (const entry of state.entries) state.selected.add(joinPath(state.path, entry.name));
  }
  rowsEl.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = selectAllEl.checked; });
  updateDeleteBtn();
});

/* ---------- Upload ---------- */

document.getElementById('upload-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles([...fileInput.files]);
  fileInput.value = '';
});

const dropzone = document.getElementById('dropzone');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropzone.classList.add('drag'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropzone.classList.remove('drag'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('drag');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});

function uploadFiles(files) {
  uploadPanel.hidden = false;
  const targetPath = state.path;
  const queue = files.map((file) => {
    const bar = el('div', { class: 'bar' });
    const status = el('span', {}, 'queued');
    const item = el('div', { class: 'upload-item' },
      el('div', { class: 'row1' },
        el('span', { class: 'u-name' }, file.name),
        status),
      el('div', { class: 'progress' }, bar));
    uploadList.prepend(item);
    return { file, bar, status };
  });

  // Sequential queue: predictable progress, no server flooding.
  (async () => {
    Shell.busy(true);
    let anyOk = false;
    for (const job of queue) {
      try {
        const result = await uploadOne(job, targetPath);
        if (result.ok) {
          anyOk = true;
          job.status.textContent = fmtBytes(result.size);
          job.bar.style.width = '100%';
        } else {
          job.status.textContent = result.error;
          job.status.classList.add('u-err');
          job.bar.classList.add('err');
          job.bar.style.width = '100%';
        }
      } catch (err) {
        job.status.textContent = err.message || 'Upload failed';
        job.status.classList.add('u-err');
        job.bar.classList.add('err');
        job.bar.style.width = '100%';
      }
    }
    Shell.busy(false);
    if (anyOk && state.path === targetPath) await load(state.path);
  })();
}

function uploadOne(job, targetPath) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload?path=' + encodeURIComponent(targetPath));
    xhr.setRequestHeader('X-CSRF-Token', API.csrf);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        job.bar.style.width = ((e.loaded / e.total) * 100).toFixed(1) + '%';
        job.status.textContent = ((e.loaded / e.total) * 100).toFixed(0) + '%';
      }
    });
    xhr.addEventListener('load', () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300 && body.results) {
        if (body.usedBytes !== undefined) Shell.updateGauge(body.usedBytes, body.quotaBytes);
        resolve(body.results[0] || { ok: false, error: 'No result returned' });
      } else {
        reject(new Error(body.error || `Upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    const form = new FormData();
    form.append('file', job.file);
    xhr.send(form);
  });
}

/* ---------- New folder ---------- */

const mkdirDialog = document.getElementById('mkdir-dialog');
const mkdirName = document.getElementById('mkdir-name');
const mkdirError = document.getElementById('mkdir-error');

document.getElementById('mkdir-btn').addEventListener('click', () => {
  mkdirName.value = '';
  mkdirError.textContent = '';
  mkdirDialog.showModal();
});

mkdirDialog.querySelector('form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  try {
    await withBusy(() => API.call('/api/files/mkdir', {
      method: 'POST',
      body: { path: state.path, name: mkdirName.value },
    }));
    mkdirDialog.close();
    await load(state.path);
  } catch (err) {
    mkdirError.textContent = err.message;
  }
});

/* ---------- Rename ---------- */

const renameDialog = document.getElementById('rename-dialog');
const renameName = document.getElementById('rename-name');
const renameError = document.getElementById('rename-error');
let renameTarget = null;

function openRename(entry, fullPath) {
  renameTarget = fullPath;
  renameName.value = entry.name;
  renameError.textContent = '';
  renameDialog.showModal();
  renameName.select();
}

renameDialog.querySelector('form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  try {
    await withBusy(() => API.call('/api/files/rename', {
      method: 'POST',
      body: { path: renameTarget, newName: renameName.value },
    }));
    renameDialog.close();
    await load(state.path);
  } catch (err) {
    renameError.textContent = err.message;
  }
});

/* ---------- Delete ---------- */

const deleteDialog = document.getElementById('delete-dialog');
const deleteSummary = document.getElementById('delete-summary');
let deleteTargets = [];

function openDelete(paths) {
  deleteTargets = paths;
  deleteSummary.textContent = paths.length === 1
    ? `Delete ${paths[0].split('/').pop()}? Folders are deleted with everything in them. This cannot be undone.`
    : `Delete ${paths.length} items? Folders are deleted with everything in them. This cannot be undone.`;
  deleteDialog.showModal();
}

deleteBtn.addEventListener('click', () => {
  if (state.selected.size) openDelete([...state.selected]);
});
document.getElementById('delete-cancel').addEventListener('click', () => deleteDialog.close());
document.getElementById('delete-confirm').addEventListener('click', async () => {
  deleteDialog.close();
  try {
    const data = await withBusy(() => API.call('/api/files/delete', {
      method: 'POST',
      body: { paths: deleteTargets },
    }));
    const failed = data.results.filter((r) => !r.ok);
    if (failed.length) toast(`${failed.length} of ${data.results.length} items could not be deleted: ${failed[0].error}`, true);
    await load(state.path);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- Preview ---------- */

const previewDialog = document.getElementById('preview-dialog');
const previewTitle = document.getElementById('preview-title');
const previewBody = document.getElementById('preview-body');
let previewPath = null;

async function openPreview(entry, fullPath) {
  previewPath = fullPath;
  previewTitle.textContent = entry.name;
  previewBody.textContent = '';
  previewDialog.showModal();
  const url = '/api/files/preview?path=' + encodeURIComponent(fullPath);
  const mime = entry.mime || '';
  try {
    if (mime.startsWith('image/')) {
      previewBody.append(el('img', { src: url, alt: entry.name }));
    } else if (mime === 'application/pdf') {
      previewBody.append(el('object', { data: url, type: 'application/pdf' },
        el('p', { style: 'padding:16px' }, 'This browser cannot show PDFs inline. ',
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); download(fullPath); } }, 'Download it instead.'))));
    } else {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Preview failed');
      }
      const text = await res.text();
      previewBody.append(el('pre', {}, text.slice(0, 500000)));
    }
  } catch (err) {
    previewBody.append(el('pre', {}, err.message));
  }
}

document.getElementById('preview-close').addEventListener('click', () => previewDialog.close());
document.getElementById('preview-download').addEventListener('click', () => download(previewPath));

/* ---------- Init ---------- */

(async () => {
  await Shell.init('files');
  await load('/');
})();
