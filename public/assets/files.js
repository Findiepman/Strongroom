'use strict';

/* ============================================================
   Files + home. One page: the home overview (bento) shows at the
   top of your storage; folders and search show the browser only.
   ============================================================ */

const PREFS_KEY = 'strongroom.prefs';
const prefs = (() => {
  try { return { view: 'list', sort: 'name', dir: 1, pins: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { view: 'list', sort: 'name', dir: 1, pins: null }; }
})();
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode: prefs just don't stick */ }
}

const state = {
  path: '/',
  items: [],          // normalized: {name, path, dir, size, mtime, mime, repo}
  readOnly: false,
  selected: new Set(),
  filter: 'all',
  search: null,       // {q, truncated} while showing search results
  overview: null,
  loading: false,
  loaded: false,      // a folder has been shown at least once
  lockedBy: [],       // locked folders the current folder is in (all open)
};

const $ = (id) => document.getElementById(id);
const filesEl = $('files');
const emptyEl = $('empty');
const homeEl = $('home');
const theadEl = $('thead');
const selectAllEl = $('select-all');
const fileInput = $('file-input');
const folderInput = $('folder-input');

function joinPath(base, name) {
  return (base === '/' ? '' : base) + '/' + name;
}
function parentPath(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
const fileUrl = (kind, p) => `/api/files/${kind}?path=${encodeURIComponent(p)}`;

/* ---------- Loading ---------- */

async function load(path, { keepSearch = false } = {}) {
  if (!keepSearch && state.search) { state.search = null; Shell.setSearch(''); }
  state.loading = true;
  if (!state.items.length) renderSkeleton();
  let lockedAt = null;
  await withBusy(async () => {
    try {
      const data = await API.call(fileUrl('list', path));
      state.path = data.path;
      state.readOnly = !!data.readOnly;
      state.lockedBy = data.lockedBy || [];
      state.loaded = true;
      state.items = data.entries.map((e) => ({ ...e, path: joinPath(data.path, e.name) }));
      Shell.updateGauge(data.usedBytes, data.quotaBytes);
      const url = state.path === '/' ? '/files' : '/files?path=' + encodeURIComponent(state.path);
      history.replaceState(null, '', url);
    } catch (err) {
      if (err.status === 423 && err.locked) { lockedAt = err.locked; return; }
      toast(err.message, true);
      if (path !== '/') { state.loading = false; return load('/'); }
    }
  });
  state.loading = false;
  if (lockedAt) {
    // A locked folder on the way: ask for its password, then try again.
    if (await askLock('open', lockedAt)) return load(path, { keepSearch });
    if (!state.loaded) return load(parentPath(lockedAt));
    render();
    return;
  }
  state.selected.clear();
  render();
  if (state.path === '/' && !state.search) loadOverview();
}

async function runSearch(q) {
  q = q.trim();
  if (q.length < 2) {
    if (state.search) { state.search = null; await load(state.path); }
    return;
  }
  try {
    const data = await withBusy(() => API.call('/api/files/search?q=' + encodeURIComponent(q)));
    state.search = { q, truncated: data.truncated };
    state.items = data.results;
    state.readOnly = false;
    state.selected.clear();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

let searchTimer = null;
Shell.onSearch = (value, now) => {
  clearTimeout(searchTimer);
  if (now) runSearch(value);
  else searchTimer = setTimeout(() => runSearch(value), 280);
};

/* ---------- Home overview ---------- */

const PALETTE = ['var(--ac)', 'var(--t-image)', 'var(--t-folder)', 'var(--t-arc)', 'var(--t-media)'];

let overviewRetry = null;
async function loadOverview(tries = 0) {
  clearTimeout(overviewRetry);
  try {
    const ov = await API.call('/api/user/overview');
    state.overview = ov;
    Shell.updateGauge(ov.usedBytes, ov.quotaBytes);
    renderOverview();
    // First time ever, the server is still counting folder sizes: ask again shortly.
    if (ov.sizesPending && tries < 40) {
      overviewRetry = setTimeout(() => { if (state.path === '/' && !state.search) loadOverview(tries + 1); }, 3000);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function renderOverview() {
  const ov = state.overview;
  if (!ov) return;
  const { usedBytes: used, quotaBytes: quota } = ov;

  // Donut: share of the quota per top-level folder, top 4 + everything else.
  const parts = ov.breakdown.filter((b) => b.bytes > 0).slice(0, 4).map((b, i) => ({ label: b.name, bytes: b.bytes, color: PALETTE[i] }));
  const rest = used - parts.reduce((n, p) => n + p.bytes, 0);
  if (rest > 0) parts.push({ label: parts.length ? 'Everything else' : 'Files', bytes: rest, color: 'var(--t-other)' });
  let acc = 0;
  const stops = [];
  for (const p of parts) {
    const from = acc;
    acc += quota > 0 ? (p.bytes / quota) * 100 : 0;
    // Tiny slices still get a visible sliver.
    const to = Math.min(100, Math.max(acc, from + 0.8));
    acc = to;
    stops.push(`${p.color} ${from.toFixed(2)}% ${to.toFixed(2)}%`);
  }
  stops.push(`var(--s3) ${acc.toFixed(2)}% 100%`);
  $('donut').style.setProperty('--ring', `conic-gradient(${stops.join(', ')})`);
  $('donut-used').textContent = fmtBytes(used);
  $('donut-of').textContent = `of ${fmtBytes(quota)}`;
  const pct = quota > 0 ? (used / quota) * 100 : 0;
  $('quota-text').textContent = `${pct < 0.1 && used > 0 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}% used`;

  const legend = $('legend');
  legend.textContent = '';
  if (!parts.length) legend.append(el('span', {}, el('em', {}, ov.sizesPending ? 'Counting folder sizes…' : 'Nothing stored yet')));
  for (const p of parts) {
    const dot = el('i');
    dot.style.background = p.color;
    legend.append(el('span', {}, dot, el('em', {}, p.label), el('b', {}, fmtBytes(p.bytes))));
  }
  const freeDot = el('i');
  freeDot.style.background = 'var(--s3)';
  legend.append(el('span', {}, freeDot, el('em', {}, 'Free'), el('b', {}, fmtBytes(Math.max(0, quota - used)))));

  const warn = $('quota-warn');
  warn.hidden = pct < 90;
  warn.textContent = pct >= 100 ? 'Storage is full. Delete something or ask an admin for more space.' : 'Almost full. Ask an admin if you need more space.';

  renderPins();
  renderRecent(ov.recent);
  renderActivity(ov.activity, ov.activityScope);
}

function pinnedPaths() {
  if (Array.isArray(prefs.pins)) return prefs.pins;
  // Until the user pins something, show the biggest top-level folders.
  return (state.overview ? state.overview.breakdown : []).slice(0, 4).map((b) => '/' + b.name);
}
function isPinned(p) { return pinnedPaths().includes(p); }
function togglePin(p) {
  const pins = [...pinnedPaths()];
  const i = pins.indexOf(p);
  if (i >= 0) pins.splice(i, 1);
  else pins.unshift(p);
  prefs.pins = pins.slice(0, 6);
  savePrefs();
  renderPins();
  toast(i >= 0 ? 'Unpinned' : 'Pinned to home');
}

function renderPins() {
  const box = $('pins');
  box.textContent = '';
  const sizes = new Map((state.overview ? state.overview.breakdown : []).map((b) => ['/' + b.name, b.bytes]));
  const pins = pinnedPaths();
  if (!pins.length) {
    box.append(el('p', { class: 'pins-empty' }, 'Pin folders from their ⋯ menu to keep them here.'));
    return;
  }
  for (const p of pins.slice(0, 4)) {
    const size = sizes.get(p);
    box.append(el('a', { class: 'pin', href: '/files?path=' + encodeURIComponent(p), onclick: (e) => { e.preventDefault(); load(p); } },
      icon(p.startsWith('/repos') ? 'branch' : 'folder'),
      el('span', {}, el('b', {}, p.split('/').pop() || 'Home'), el('small', {}, size != null ? fmtBytes(size) : parentPath(p)))));
  }
}

function renderRecent(recent) {
  const box = $('recent');
  box.textContent = '';
  if (!recent.length) {
    box.append(el('p', { class: 'pins-empty' }, 'Files you upload show up here.'));
    return;
  }
  for (const r of recent.slice(0, 6)) {
    const item = { ...r, dir: false };
    box.append(el('button', { class: 'rc', onclick: () => openItem(item), title: r.path },
      thumb(item),
      el('div', { class: 'meta' }, el('b', {}, r.name), el('small', {}, `${relTime(r.created)} · ${fmtBytes(r.size)}`))));
  }
}

function renderActivity(rows, scope) {
  const box = $('activity');
  box.textContent = '';
  $('audit-link').hidden = Shell.user.role !== 'admin';
  const groups = groupEvents(rows.filter((r) => r.action !== 'preview')).slice(0, 5);
  if (!groups.length) {
    box.append(el('p', { class: 'ev-empty' }, scope === 'you' ? 'Nothing yet. Your uploads and sign-ins show up here.' : 'Nothing has happened yet.'));
    return;
  }
  for (const g of groups) {
    const d = describeGroup(g);
    box.append(el('div', { class: 'ev' },
      el('span', { class: 'ek ' + d.cls }, icon(d.icon, 'sm')),
      el('div', { class: 'ev-body' }, el('span', {}, d.text), el('small', {}, [d.sub, relTime(g.created_at)].filter(Boolean).join(' · ')))));
  }
}

/* ---------- Thumbnails & icons ---------- */

function thumb(item) {
  const k = fileKind(item);
  const box = el('div', { class: 'thumb' }, icon(k.icon));
  box.style.setProperty('--h', k.hue);
  if (!item.dir) {
    const ext = fileExt(item.name);
    if (ext) box.append(el('span', { class: 'ext' }, ext));
  }
  if ((item.mime || '').startsWith('image/') && !(item.mime || '').includes('svg')) {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', src: fileUrl('preview', item.path) + '&thumb=1' });
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

function fileIcon(item) {
  const k = fileKind(item);
  const box = el('span', { class: 'fi' }, icon(k.icon));
  box.style.setProperty('--h', k.hue);
  if ((item.mime || '').startsWith('image/') && !(item.mime || '').includes('svg')) {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', src: fileUrl('preview', item.path) + '&thumb=1' });
    img.addEventListener('load', () => box.querySelector('svg')?.remove());
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

/* ---------- Browser rendering ---------- */

function visibleItems() {
  let items = state.items;
  if (state.filter !== 'all') items = items.filter((i) => fileKind(i).filter === state.filter);
  const { sort, dir } = prefs;
  return [...items].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    let c = 0;
    if (sort === 'size') c = (a.size || 0) - (b.size || 0);
    else if (sort === 'mtime') c = (a.mtime || 0) - (b.mtime || 0);
    if (c === 0) c = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    return c * dir;
  });
}

function canSelect(item) {
  return !state.readOnly && !item.repo && !item.path.startsWith('/repos');
}

function renderSkeleton() {
  filesEl.textContent = '';
  for (let i = 0; i < 6; i++) filesEl.append(el('div', { class: 'skel' }));
}

function render() {
  const atHome = state.path === '/' && !state.search;
  homeEl.hidden = !atHome;
  $('browser-title').textContent = state.search ? 'Search results' : atHome ? 'My files' : state.path.split('/').pop();
  document.title = state.search ? `"${state.search.q}" · Strongroom` : atHome ? 'Strongroom' : `${state.path.split('/').pop()} · Strongroom`;
  renderCrumb();
  renderToolbar();

  const items = visibleItems();
  const grid = prefs.view === 'grid';
  filesEl.textContent = '';
  filesEl.className = grid ? 'fgrid' : 'flist';
  theadEl.hidden = grid || !items.length;

  for (const item of items) filesEl.append(grid ? tileFor(item) : rowFor(item));

  emptyEl.hidden = items.length > 0;
  emptyEl.textContent = '';
  if (!items.length) {
    if (state.search) {
      emptyEl.append(icon('search'), el('b', {}, 'No matches'), `Nothing named like "${state.search.q}" in your files.`);
    } else if (state.items.length) {
      emptyEl.append(icon('folder'), el('b', {}, 'Nothing of that type here'), 'Try another filter.');
    } else {
      emptyEl.append(icon('folderup'), el('b', {}, 'This folder is empty'),
        state.readOnly ? 'Repos are filled by the GitHub puller.' : 'Drop files anywhere on the page, or use Upload.');
    }
  }
  if (state.search && state.search.truncated) {
    filesEl.append(el('p', { class: 'hint' }, 'Showing the first matches only. Type more to narrow it down.'));
  }
  syncSelection();
}

function renderCrumb() {
  const crumb = $('crumb');
  crumb.textContent = '';
  if (state.search) {
    crumb.append(el('a', { href: '/files', onclick: (e) => { e.preventDefault(); load(state.path); } }, icon('home', 'sm')),
      icon('chev', 'sm'), el('span', { class: 'here' }, `${state.items.length} match${state.items.length === 1 ? '' : 'es'} for "${state.search.q}"`));
    return;
  }
  const parts = state.path.split('/').filter(Boolean);
  crumb.append(parts.length
    ? el('a', { href: '/files', onclick: (e) => { e.preventDefault(); load('/'); } }, icon('home', 'sm'), ' Home')
    : el('span', { class: 'here' }, `${state.items.length} item${state.items.length === 1 ? '' : 's'}`));
  parts.forEach((part, i) => {
    const target = '/' + parts.slice(0, i + 1).join('/');
    crumb.append(icon('chev', 'sm'));
    if (i < parts.length - 1) crumb.append(el('a', { href: '#', onclick: (e) => { e.preventDefault(); load(target); } }, part));
    else crumb.append(el('span', { class: 'here' }, part));
  });
  if (state.readOnly) crumb.append(el('span', { class: 'badge ro-badge' }, icon('lock', 'sm'), 'read-only'));
  if (state.lockedBy.length) {
    crumb.append(el('button', {
      class: 'badge ro-badge lock-badge', title: 'Opened with its password. Locks again after 15 minutes of not using it.',
      onclick: () => lockNow(state.lockedBy),
    }, icon('lock', 'sm'), 'Locked folder · Lock now'));
  }
}

function renderToolbar() {
  const ro = state.readOnly || !!state.search;
  $('upload-btn').disabled = ro;
  $('mkdir-btn').disabled = ro;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view)));
  document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
  $('sort').value = prefs.sort;
  theadEl.querySelectorAll('[data-sort]').forEach((b) => {
    b.classList.toggle('on', b.dataset.sort === prefs.sort);
    b.querySelector('svg')?.remove();
    if (b.dataset.sort === prefs.sort) b.append(icon(prefs.dir > 0 ? 'arrowup' : 'arrowdown', 'sm'));
  });
  selectAllEl.disabled = state.readOnly;
}

function subLine(item) {
  if (state.search) return parentPath(item.path) === '/' ? 'Home' : parentPath(item.path);
  if (item.repo) return 'Pulled repositories · read-only';
  if (item.dir) return item.lock ? fileKind(item).kind : 'Folder';
  return fileKind(item).kind;
}

function checkFor(item) {
  if (!canSelect(item)) return el('span');
  const c = el('input', { type: 'checkbox', 'aria-label': `Select ${item.name}` });
  c.checked = state.selected.has(item.path);
  c.addEventListener('click', (e) => e.stopPropagation());
  c.addEventListener('change', () => {
    if (c.checked) state.selected.add(item.path); else state.selected.delete(item.path);
    syncSelection();
  });
  return c;
}

function moreBtn(item) {
  return el('button', {
    class: 'icon-btn more', 'aria-label': `Actions for ${item.name}`, 'aria-haspopup': 'menu',
    onclick: (e) => { e.stopPropagation(); itemMenu(item, e.currentTarget); },
  }, icon('more'));
}

function rowFor(item) {
  const row = el('div', { class: 'frow', 'data-path': item.path },
    checkFor(item),
    fileIcon(item),
    el('div', { class: 'name' },
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openItem(item); } }, item.name),
      el('small', {}, subLine(item))),
    el('span', { class: 'num' }, item.dir ? '—' : fmtBytes(item.size)),
    el('span', { class: 'when', title: item.mtime ? fmtDate(item.mtime) : '' }, item.mtime ? relTime(item.mtime) : '—'),
    moreBtn(item));
  row.addEventListener('click', (e) => {
    // Click on the row toggles selection once something is selected, otherwise opens.
    if (state.selected.size && canSelect(item)) toggleSelect(item.path);
    else openItem(item);
    e.preventDefault();
  });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); itemMenu(item, { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }); });
  return row;
}

function tileFor(item) {
  const tile = el('div', { class: 'ftile', 'data-path': item.path, tabindex: '0' },
    thumb(item),
    el('div', { class: 'meta' },
      el('div', {}, el('b', {}, item.name), el('small', {}, item.dir ? subLine(item) : `${fmtBytes(item.size)} · ${relTime(item.mtime)}`))),
    moreBtn(item));
  const check = checkFor(item);
  if (check.tagName === 'INPUT') { check.classList.add('tick'); tile.append(check); }
  tile.addEventListener('click', () => {
    if (state.selected.size && canSelect(item)) toggleSelect(item.path);
    else openItem(item);
  });
  tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') openItem(item); });
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); itemMenu(item, { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }); });
  return tile;
}

function itemMenu(item, anchor) {
  const items = [];
  if (item.dir) {
    items.push(menuItem('folder', 'Open', () => load(item.path)));
    items.push(menuItem('zip', 'Download as zip', () => guardedDownload('download-zip', item.path)));
    if (!item.repo) items.push(menuItem('star', isPinned(item.path) ? 'Unpin from home' : 'Pin to home', () => togglePin(item.path)));
    if (canSelect(item)) {
      if (!item.lock) items.push(menuItem('lock', 'Lock with password…', () => lockFolder(item.path)));
      else {
        if (item.lock.open) items.push(menuItem('lock', 'Lock now', () => lockNow([item.path])));
        items.push(menuItem('key', 'Remove lock…', () => removeLock(item.path)));
      }
    }
  } else {
    if (isPreviewable(item)) items.push(menuItem('eye', 'Preview', () => openPreview(item)));
    items.push(menuItem('download', 'Download', () => guardedDownload('download', item.path)));
  }
  if (state.search) items.push(menuItem('folder', 'Show in folder', () => load(parentPath(item.path))));
  if (canSelect(item)) {
    items.push(el('hr'));
    items.push(menuItem('edit', 'Rename', () => openRename(item)));
    items.push(menuItem('trash', 'Delete', () => openDelete([item.path]), { danger: true }));
  }
  openMenu(anchor, items);
}

function openItem(item) {
  if (item.dir) load(item.path);
  else if (isPreviewable(item)) openPreview(item);
  else guardedDownload('download', item.path);
}

// Downloads are plain navigations, so a refusal would land as a JSON file.
// Ask the server first (check=1) and get the folder password if it's needed.
async function guardedDownload(kind, p) {
  try {
    await API.call(fileUrl(kind, p) + '&check=1');
  } catch (err) {
    if (err.status === 423 && err.locked) {
      if (await askLock('open', err.locked)) return guardedDownload(kind, p);
      return;
    }
    toast(err.message, true);
    return;
  }
  navDownload(fileUrl(kind, p));
}

function navDownload(url) {
  // Navigation keeps the httpOnly cookie flow; no tokens in URLs.
  const a = el('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------- Selection ---------- */

function toggleSelect(p) {
  if (state.selected.has(p)) state.selected.delete(p); else state.selected.add(p);
  syncSelection();
}

function syncSelection() {
  const selectable = visibleItems().filter(canSelect);
  for (const p of [...state.selected]) if (!state.items.some((i) => i.path === p)) state.selected.delete(p);
  const n = state.selected.size;
  filesEl.querySelectorAll('[data-path]').forEach((node) => {
    const on = state.selected.has(node.dataset.path);
    node.classList.toggle('sel', on);
    const c = node.querySelector('input[type="checkbox"]');
    if (c) c.checked = on;
  });
  filesEl.classList.toggle('selecting', n > 0);
  selectAllEl.checked = n > 0 && n === selectable.length;
  selectAllEl.indeterminate = n > 0 && n < selectable.length;
  $('selbar').hidden = n === 0;
  document.body.classList.toggle('has-selbar', n > 0);
  $('sel-count').textContent = `${n} selected`;
}

selectAllEl.addEventListener('change', () => {
  state.selected.clear();
  if (selectAllEl.checked) visibleItems().filter(canSelect).forEach((i) => state.selected.add(i.path));
  syncSelection();
});
$('sel-clear').addEventListener('click', () => { state.selected.clear(); syncSelection(); });
$('sel-delete').addEventListener('click', () => openDelete([...state.selected]));
$('sel-download').addEventListener('click', () => {
  const chosen = state.items.filter((i) => state.selected.has(i.path));
  chosen.forEach((item, i) => setTimeout(() => {
    guardedDownload(item.dir ? 'download-zip' : 'download', item.path);
  }, i * 400));
  if (chosen.length > 3) toast('Your browser may ask to allow multiple downloads.');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected.size && !document.querySelector('dialog[open]')) {
    state.selected.clear();
    syncSelection();
  }
});

/* ---------- Toolbar wiring ---------- */

document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  render();
}));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  prefs.view = b.dataset.view;
  savePrefs();
  render();
}));
$('sort').addEventListener('change', (e) => {
  prefs.sort = e.target.value;
  prefs.dir = prefs.sort === 'name' ? 1 : -1;
  savePrefs();
  render();
});
theadEl.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
  if (prefs.sort === b.dataset.sort) prefs.dir *= -1;
  else { prefs.sort = b.dataset.sort; prefs.dir = prefs.sort === 'name' ? 1 : -1; }
  savePrefs();
  render();
}));

/* ---------- Upload ---------- */

$('upload-btn').addEventListener('click', (e) => openMenu(e.currentTarget, [
  menuItem('upload', 'Upload files', () => fileInput.click()),
  menuItem('folderup', 'Upload a folder', () => folderInput.click()),
], 'right'));
$('tile-files').append(icon('upload', 'sm'), 'Choose files');
$('tile-folder').append(icon('folderup', 'sm'), 'Choose a folder');
$('tile-files').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
$('tile-folder').addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });
$('drop-tile').addEventListener('click', () => fileInput.click());
$('drop-tile').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles([...fileInput.files]);
  fileInput.value = '';
});
folderInput.addEventListener('change', () => {
  if (folderInput.files.length) uploadFiles([...folderInput.files]);
  folderInput.value = '';
});

const veil = $('drag-veil');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  if (state.readOnly || state.search) return;
  veil.hidden = false;
  veil.textContent = state.path === '/' ? 'Drop to upload to Home' : `Drop to upload to ${state.path.split('/').pop()}`;
  $('drop-tile').classList.add('drag');
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; $('drop-tile').classList.remove('drag'); }
});
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  $('drop-tile').classList.remove('drag');
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) uploadFiles(files);
});

const tray = { el: $('tray'), list: $('tray-list'), head: $('tray-head'), bar: $('tray-bar'), jobs: [], running: false };
$('tray-close').addEventListener('click', () => {
  if (tray.running) { toast('Uploads keep running in the background.'); tray.el.classList.add('collapsed'); return; }
  tray.el.hidden = true;
  tray.list.textContent = '';
  tray.jobs = [];
});
$('tray-toggle').addEventListener('click', () => tray.el.classList.toggle('collapsed'));

function updateTray() {
  const total = tray.jobs.length;
  const done = tray.jobs.filter((j) => j.state === 'ok' || j.state === 'err').length;
  const failed = tray.jobs.filter((j) => j.state === 'err').length;
  const bytesAll = tray.jobs.reduce((n, j) => n + j.file.size, 0) || 1;
  const bytesDone = tray.jobs.reduce((n, j) => n + (j.state === 'ok' || j.state === 'err' ? j.file.size : j.loaded || 0), 0);
  tray.bar.style.width = ((bytesDone / bytesAll) * 100).toFixed(1) + '%';
  tray.head.textContent = done < total
    ? `Uploading ${done + 1} of ${total}`
    : failed ? `${total - failed} uploaded, ${failed} failed` : `${total} upload${total === 1 ? '' : 's'} complete`;
}

function uploadFiles(files) {
  if (state.readOnly || state.search) {
    toast(state.search ? 'Open a folder first, then upload.' : 'Repos are read-only here. Update them with the GitHub puller.', true);
    return;
  }
  tray.el.hidden = false;
  tray.el.classList.remove('collapsed');
  const targetPath = state.path;
  const jobs = files.map((file) => {
    // Folder picks carry their path inside the chosen folder; keep it so the tree is rebuilt server-side.
    const relPath = file.webkitRelativePath || '';
    const subdir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const bar = el('i');
    const status = el('span', { class: 'st' }, 'waiting');
    const item = el('div', { class: 'up-item' },
      el('div', { class: 'r1' }, el('span', { title: relPath || file.name }, relPath || file.name), status),
      el('div', { class: 'progress' }, bar));
    tray.list.append(item);
    return { file, subdir, bar, status, state: 'queued', loaded: 0, target: targetPath };
  });
  tray.jobs.push(...jobs);
  updateTray();
  if (!tray.running) drainQueue();
}

// Sequential queue: predictable progress, no server flooding.
async function drainQueue() {
  tray.running = true;
  Shell.busy(true);
  let anyOk = false;
  const touched = new Set();
  for (let job; (job = tray.jobs.find((j) => j.state === 'queued'));) {
    job.state = 'running';
    job.status.textContent = '0%';
    job.status.parentNode.parentNode.scrollIntoView({ block: 'nearest' });
    try {
      const result = await uploadOne(job);
      if (result.ok) {
        anyOk = true;
        touched.add(job.target);
        job.state = 'ok';
        job.status.textContent = fmtBytes(result.size);
        job.status.className = 'st ok';
        job.bar.className = 'ok';
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      job.state = 'err';
      job.status.textContent = err.message || 'Upload failed';
      job.status.className = 'st err';
      job.bar.className = 'err';
    }
    job.bar.style.width = '100%';
    updateTray();
  }
  Shell.busy(false);
  tray.running = false;
  if (anyOk && touched.has(state.path) && !state.search) await load(state.path);
  else if (anyOk && state.path === '/') loadOverview();
  if (!tray.jobs.some((j) => j.state === 'err')) {
    setTimeout(() => { if (!tray.running && !tray.jobs.some((j) => j.state === 'err')) $('tray-close').click(); }, 4000);
  }
}

async function uploadOne(job) {
  // Folder uploads are many small sequential requests; back off politely on the rate limit.
  for (let attempt = 0; ; attempt++) {
    try {
      return await uploadRequest(job);
    } catch (err) {
      if (err.status === 429 && attempt < 5) {
        job.status.textContent = 'rate limited, waiting';
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
  }
}

function uploadRequest(job) {
  return new Promise((resolve, reject) => {
    const dest = job.subdir ? joinPath(job.target, job.subdir) : job.target;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload?path=' + encodeURIComponent(dest) + (job.subdir ? '&mkdirs=1' : ''));
    xhr.setRequestHeader('X-CSRF-Token', API.csrf);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      job.loaded = (e.loaded / e.total) * job.file.size;
      job.bar.style.width = pct.toFixed(1) + '%';
      job.status.textContent = pct.toFixed(0) + '%';
      updateTray();
    });
    xhr.addEventListener('load', () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300 && body.results) {
        if (body.usedBytes !== undefined) Shell.updateGauge(body.usedBytes, body.quotaBytes);
        resolve(body.results[0] || { ok: false, error: 'No result returned' });
      } else {
        const err = new Error(body.error || `Upload failed (${xhr.status})`);
        err.status = xhr.status;
        reject(err);
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    const form = new FormData();
    form.append('file', job.file);
    xhr.send(form);
  });
}

/* ---------- New folder ---------- */

const mkdirDialog = $('mkdir-dialog');
$('mkdir-btn').addEventListener('click', () => {
  $('mkdir-name').value = '';
  $('mkdir-error').textContent = '';
  $('mkdir-where').textContent = `In ${state.path === '/' ? 'Home' : state.path}`;
  mkdirDialog.showModal();
});
mkdirDialog.querySelector('form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  try {
    const name = $('mkdir-name').value.trim();
    await withBusy(() => API.call('/api/files/mkdir', { method: 'POST', body: { path: state.path, name } }));
    mkdirDialog.close();
    await load(state.path);
    toast(`Created ${name}`);
  } catch (err) {
    $('mkdir-error').textContent = err.message;
  }
});

/* ---------- Rename ---------- */

const renameDialog = $('rename-dialog');
let renameTarget = null;
function openRename(item) {
  renameTarget = item;
  $('rename-name').value = item.name;
  $('rename-error').textContent = '';
  renameDialog.showModal();
  // Select the name without the extension, like a desktop file manager.
  const dot = item.dir ? -1 : item.name.lastIndexOf('.');
  $('rename-name').setSelectionRange(0, dot > 0 ? dot : item.name.length);
}
renameDialog.querySelector('form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const newName = $('rename-name').value.trim();
  try {
    await withBusy(() => API.call('/api/files/rename', { method: 'POST', body: { path: renameTarget.path, newName } }));
    renameDialog.close();
    // Keep a pin pointing at a renamed folder.
    if (renameTarget.dir && Array.isArray(prefs.pins)) {
      const np = joinPath(parentPath(renameTarget.path), newName);
      prefs.pins = prefs.pins.map((p) => (p === renameTarget.path ? np : p.startsWith(renameTarget.path + '/') ? np + p.slice(renameTarget.path.length) : p));
      savePrefs();
    }
    if (state.search) await runSearch(state.search.q); else await load(state.path);
  } catch (err) {
    $('rename-error').textContent = err.message;
  }
});

/* ---------- Delete ---------- */

const deleteDialog = $('delete-dialog');
let deleteTargets = [];
function openDelete(paths) {
  deleteTargets = paths;
  const dirs = state.items.filter((i) => paths.includes(i.path) && i.dir).length;
  $('delete-title').textContent = paths.length === 1 ? `Delete ${paths[0].split('/').pop()}?` : `Delete ${paths.length} items?`;
  $('delete-summary').textContent = (dirs ? 'Folders are deleted with everything in them. ' : '') + 'There is no trash. This cannot be undone.';
  deleteDialog.showModal();
}
$('delete-cancel').addEventListener('click', () => deleteDialog.close());
$('delete-confirm').addEventListener('click', async () => {
  deleteDialog.close();
  try {
    const data = await withBusy(() => API.call('/api/files/delete', { method: 'POST', body: { paths: deleteTargets } }));
    const failed = data.results.filter((r) => !r.ok);
    const ok = data.results.length - failed.length;
    if (failed.length) toast(`${failed.length} of ${data.results.length} could not be deleted: ${failed[0].error}`, true);
    else toast(`Deleted ${ok === 1 ? deleteTargets[0].split('/').pop() : ok + ' items'}`);
    if (Array.isArray(prefs.pins)) {
      prefs.pins = prefs.pins.filter((p) => !deleteTargets.some((d) => p === d || p.startsWith(d + '/')));
      savePrefs();
    }
    state.selected.clear();
    if (state.search) await runSearch(state.search.q); else await load(state.path);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- Preview ---------- */

const previewDialog = $('preview-dialog');
let previewItem = null;
async function openPreview(item) {
  // The folder may have locked itself again since it was opened.
  try {
    await API.call(fileUrl('download', item.path) + '&check=1');
  } catch (err) {
    if (err.status === 423 && err.locked && await askLock('open', err.locked)) return openPreview(item);
    if (err.status !== 423) toast(err.message, true);
    return;
  }
  previewItem = item;
  $('preview-title').textContent = item.name;
  $('preview-sub').textContent = [fileKind(item).kind, item.size != null ? fmtBytes(item.size) : '', parentPath(item.path)].filter(Boolean).join(' · ');
  const body = $('preview-body');
  body.textContent = '';
  previewDialog.showModal();
  const url = fileUrl('preview', item.path);
  const mime = item.mime || '';
  try {
    if (mime.startsWith('image/')) {
      body.append(el('img', { src: url, alt: item.name }));
    } else if (mime === 'application/pdf') {
      body.append(el('object', { data: url, type: 'application/pdf' },
        el('p', { class: 'sub', style: 'padding:20px' }, 'This browser cannot show PDFs inline. Use Download instead.')));
    } else {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Preview failed');
      }
      const text = await res.text();
      body.append(el('pre', {}, text.slice(0, 500000)));
    }
  } catch (err) {
    body.append(el('pre', {}, err.message));
  }
}
$('preview-close').addEventListener('click', () => previewDialog.close());
$('preview-download').addEventListener('click', () => guardedDownload('download', previewItem.path));
previewDialog.addEventListener('click', (e) => { if (e.target === previewDialog) previewDialog.close(); });

/* ---------- Locked folders ---------- */

const lockDialog = $('lock-dialog');
let lockJob = null; // {mode, path, done(ok)}

const LOCK_TEXT = {
  open: {
    title: (n) => `Open ${n}`,
    sub: 'This folder is locked. It stays open for 15 minutes after you last use it, or until you lock it or sign out.',
    label: 'Folder password', go: 'Open', autocomplete: 'current-password',
  },
  create: {
    title: (n) => `Lock ${n}`,
    sub: 'Everything inside will need this password, on top of your sign-in. It locks again after 15 minutes of not using it. '
      + 'Locked folders are hidden over SFTP. If you forget the password, it can only be removed on the server.',
    label: 'New folder password', go: 'Lock folder', autocomplete: 'new-password',
  },
  remove: {
    title: (n) => `Remove the lock from ${n}`,
    sub: 'Type the folder password. After this, your sign-in alone opens everything inside again.',
    label: 'Folder password', go: 'Remove lock', autocomplete: 'current-password',
  },
};

// Shows the password dialog. Resolves true once the server said yes, false if cancelled.
function askLock(mode, p) {
  if (lockJob) lockJob.done(false);
  const t = LOCK_TEXT[mode];
  const name = p.split('/').pop() || 'Home';
  $('lock-title').textContent = t.title(name);
  $('lock-sub').textContent = t.sub;
  $('lock-pw-label').textContent = t.label;
  $('lock-go').textContent = t.go;
  $('lock-pw').value = '';
  $('lock-pw2').value = '';
  $('lock-pw').setAttribute('autocomplete', t.autocomplete);
  $('lock-pw2-field').hidden = mode !== 'create';
  $('lock-user').value = 'folder:' + p; // lets a password manager keep one entry per folder
  $('lock-error').textContent = '';
  return new Promise((resolve) => {
    lockJob = { mode, path: p, done: (ok) => { lockJob = null; resolve(ok); } };
    lockDialog.showModal();
    $('lock-pw').focus();
  });
}

lockDialog.querySelector('form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return; // the close event resolves it
  e.preventDefault();
  if (!lockJob) return lockDialog.close();
  const { mode, path: p } = lockJob;
  const password = $('lock-pw').value;
  if (mode === 'create' && password !== $('lock-pw2').value) {
    $('lock-error').textContent = 'The two passwords are not the same';
    return;
  }
  const url = { open: '/api/files/unlock', create: '/api/files/lock', remove: '/api/files/unlock-remove' }[mode];
  try {
    await withBusy(() => API.call(url, { method: 'POST', body: { path: p, password } }));
  } catch (err) {
    $('lock-error').textContent = err.message;
    $('lock-pw').select();
    return;
  }
  const job = lockJob;
  lockJob = null;
  lockDialog.close();
  job.done(true);
});
lockDialog.addEventListener('close', () => { if (lockJob) lockJob.done(false); });

async function lockFolder(p) {
  if (!(await askLock('create', p))) return;
  toast(`Locked ${p.split('/').pop()}. It's open for you now; it locks again after 15 minutes of not using it.`);
  await load(state.path, { keepSearch: true });
}

async function removeLock(p) {
  if (!(await askLock('remove', p))) return;
  toast(`Removed the lock from ${p.split('/').pop()}`);
  await load(state.path, { keepSearch: true });
}

// Close locked folders for this session now. If you're inside one, go to just outside it.
async function lockNow(paths) {
  try {
    for (const p of paths) await API.call('/api/files/relock', { method: 'POST', body: { path: p } });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  toast(paths.length === 1 ? `Locked ${paths[0].split('/').pop()}` : 'Locked');
  const outer = state.lockedBy.length ? state.lockedBy[0] : null;
  if (outer && paths.some((p) => state.path === p || state.path.startsWith(p + '/'))) await load(parentPath(outer));
  else await load(state.path);
}

// Enter in a dialog submits with the form's first button, which is Cancel in
// these dialogs. Make Cancel a plain button, so Enter does the real action.
document.querySelectorAll('dialog form button[value="cancel"]').forEach((b) => {
  b.type = 'button';
  b.addEventListener('click', () => b.closest('dialog').close());
});

/* ---------- Init ---------- */

(async () => {
  await Shell.init('files');
  hydrateIcons();
  const params = new URLSearchParams(window.location.search);
  await load(params.get('path') || '/');
  const q = params.get('q');
  if (q) { Shell.setSearch(q); await runSearch(q); }
})();
