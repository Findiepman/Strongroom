'use strict';

// Shared API helper. CSRF token lives in memory only, never in storage.
const API = {
  csrf: null,
  user: null,

  async call(path, { method = 'GET', body, headers = {} } = {}) {
    const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (method !== 'GET' && this.csrf) opts.headers['X-CSRF-Token'] = this.csrf;
    const res = await fetch(path, opts);
    if (res.status === 401 && !path.endsWith('/login')) {
      window.location.href = '/';
      throw new Error('Signed out');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  async me() {
    const data = await this.call('/api/auth/me');
    this.csrf = data.csrf;
    this.user = data.user;
    return data.user;
  },
};

function fmtBytes(n) {
  if (n == null) return '-';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Element builder: el('td', {class: 'num'}, child1, 'text')
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    // The CSP blocks style="" attributes; CSSOM writes are allowed.
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
// toast('Saved') / toast('Failed', true) / toast('Deleted', false, {label: 'Undo', run: fn})
function toast(message, isError = false, action = null) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', { class: 'toast' + (isError ? ' err' : ''), role: 'status' }, el('span', {}, message));
  if (action) {
    t.append(el('button', { class: 'btn sm', onclick: () => { t.remove(); action.run(); } }, action.label));
  }
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), action ? 8000 : 5000);
}

/* ---------- Icons (inline SVG, stroke style) ---------- */

const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  pdf: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  file: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
  text: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 12h6M9 15.5h6M9 19h3"/>',
  zip: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M12 3v5M12 10v2M10 14h4v4h-4z"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  branch: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-12 6"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  folderup: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 16v-5M9.5 13.5 12 11l2.5 2.5"/>',
  folderplus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  chevd: '<path d="m6 9 6 6 6-6"/>',
  arrowup: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowdown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  vault: '<rect x="3.5" y="4" width="17" height="16" rx="3"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V7M12 17v-1.8M15.2 12H17M7 12h1.8M7 20v1.5M17 20v1.5"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  star: '<path d="m12 4 2.4 5 5.6.8-4 4 1 5.6L12 16.7 7 19.4l1-5.6-4-4 5.6-.8z"/>',
  logout: '<path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
  home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-5.5 6-5.5s6 2 6 5.5M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.8c2 .6 3 2.4 3 5.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/>',
};

function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ICONS.file; // static strings from ICONS only
  return svg;
}

// Static markup marks icons as <button data-icon="upload">; fill them in once.
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    if (node.querySelector(':scope > svg.ic')) return;
    const small = !node.classList.contains('icon-btn') && !node.closest('.seg');
    node.prepend(icon(node.dataset.icon, small ? 'sm' : ''));
  });
}

/* ---------- File kinds ---------- */

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|ps1|bat|json|ya?ml|toml|xml|html?|css|scss|sql|lua|sk)$/i;

// -> {kind, icon, hue, filter}  filter is the chip group: images | docs | archives | other
function fileKind(entry) {
  if (entry.repo) return { kind: 'Repository mount', icon: 'branch', hue: 'var(--t-text)', filter: 'folders' };
  if (entry.dir) return { kind: 'Folder', icon: 'folder', hue: 'var(--t-folder)', filter: 'folders' };
  const m = entry.mime || '';
  const n = entry.name || '';
  if (m.startsWith('image/')) return { kind: 'Image', icon: 'image', hue: 'var(--t-image)', filter: 'images' };
  if (m === 'application/pdf') return { kind: 'PDF', icon: 'pdf', hue: 'var(--t-doc)', filter: 'docs' };
  if (/\.(docx?|odt|rtf|xlsx?|ods|csv|pptx?|odp|md)$/i.test(n)) return { kind: 'Document', icon: 'text', hue: 'var(--t-doc)', filter: 'docs' };
  if (CODE_EXT.test(n)) return { kind: 'Code', icon: 'code', hue: 'var(--t-text)', filter: 'docs' };
  if (m.startsWith('text/')) return { kind: 'Text', icon: 'text', hue: 'var(--t-text)', filter: 'docs' };
  if (m.startsWith('video/')) return { kind: 'Video', icon: 'media', hue: 'var(--t-media)', filter: 'other' };
  if (m.startsWith('audio/')) return { kind: 'Audio', icon: 'audio', hue: 'var(--t-media)', filter: 'other' };
  if (/zip|compressed|tar|gzip|7z|rar/.test(m) || /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|vsix|jar)$/i.test(n)) {
    return { kind: 'Archive', icon: 'zip', hue: 'var(--t-arc)', filter: 'archives' };
  }
  return { kind: 'File', icon: 'file', hue: 'var(--t-other)', filter: 'other' };
}

function isPreviewable(entry) {
  if (entry.dir) return false;
  const m = entry.mime || '';
  return m.startsWith('image/') || m === 'application/pdf' || m.startsWith('text/');
}

function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i > name.length - 7 ? name.slice(i + 1) : '';
}

/* ---------- Time ---------- */

function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayMs = 86400000;
  if (ms >= today.getTime()) return `Today ${hm}`;
  if (ms >= today.getTime() - dayMs) return `Yesterday ${hm}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${d.getDate()} ${months[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
}

/* ---------- Audit events: describe + group ---------- */

// Actions that come in bursts (folder uploads, bulk deletes) and get grouped.
// Same thing happening again and again: shown as "signed in 3 times".
const REPEATS = new Set(['login.success', 'logout', 'sftp.login', 'login.fail', 'sftp.login.fail']);
const GROUPABLE = new Set(['upload', 'sftp.upload', 'delete', 'sftp.delete', 'download', 'preview', 'upload.blocked', ...REPEATS]);
const GROUP_WINDOW_MS = 10 * 60 * 1000;

function eventPath(r) {
  // detail looks like "/a/b/c.txt (123 bytes)" or "/a/b/c.txt: reason"
  return String(r.detail || '').replace(/ \(\d+ bytes\)$/, '').replace(/: .*$/, '');
}
function parentOf(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
// Top-level folder an event belongs to ("/School/auth-system/x.js" -> "/School/auth-system")
function groupRoot(paths) {
  if (paths.length === 1) return parentOf(paths[0]);
  let common = parentOf(paths[0]).split('/');
  for (const p of paths.slice(1)) {
    const parts = parentOf(p).split('/');
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join('/') || '/';
}

// rows are newest first. Consecutive same-user same-action bursts become one group.
function groupEvents(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && GROUPABLE.has(r.action) && last.action === r.action && last.username === r.username
        && last.oldest - r.created_at <= GROUP_WINDOW_MS) {
      last.items.push(r);
      last.oldest = r.created_at;
      continue;
    }
    out.push({ action: r.action, username: r.username, created_at: r.created_at, oldest: r.created_at, items: [r] });
  }
  return out;
}

const VERBS = {
  'upload': ['uploaded', 'k-up', 'upload'],
  'sftp.upload': ['uploaded over SFTP', 'k-up', 'upload'],
  'upload.blocked': ['had an upload blocked', 'k-fail', 'shield'],
  'download': ['downloaded', 'k-down', 'download'],
  'download.zip': ['downloaded a zip of', 'k-down', 'zip'],
  'preview': ['opened', 'k-down', 'eye'],
  'delete': ['deleted', 'k-del', 'trash'],
  'sftp.delete': ['deleted over SFTP', 'k-del', 'trash'],
  'rename': ['renamed', 'k-admin', 'edit'],
  'mkdir': ['created folder', 'k-admin', 'folderplus'],
  'login.success': ['signed in', 'k-auth', 'lock'],
  'login.fail': ['failed to sign in', 'k-fail', 'shield'],
  'logout': ['signed out', 'k-auth', 'logout'],
  'sftp.login': ['connected over SFTP', 'k-auth', 'terminal'],
  'sftp.login.fail': ['failed an SFTP sign-in', 'k-fail', 'shield'],
  'password.change': ['changed their password', 'k-auth', 'key'],
  'password.fail': ['entered a wrong current password', 'k-fail', 'key'],
  'repo.pull': ['pulled repo', 'k-admin', 'branch'],
  'user.create': ['created account', 'k-admin', 'users'],
  'user.delete': ['deleted account', 'k-admin', 'users'],
  'user.force_logout': ['signed out everywhere:', 'k-admin', 'logout'],
  'quota.set': ['changed quota:', 'k-admin', 'settings'],
  'role.set': ['changed role:', 'k-admin', 'settings'],
};

// -> {text, sub, cls, icon, items?}
function describeGroup(g) {
  const [verb, cls, ic] = VERBS[g.action] || [g.action, 'k-admin', 'clock'];
  const who = g.username || 'someone';
  const n = g.items.length;
  if (n > 1 && REPEATS.has(g.action)) {
    const fail = /fail$/.test(g.action);
    const tried = [...new Set(g.items.map((r) => (String(r.detail).match(/username=(\S+)/) || [])[1]).filter(Boolean))];
    return {
      text: fail ? `${n} failed ${g.action.startsWith('sftp') ? 'SFTP ' : ''}sign-ins` : `${who} ${verb} ${n} times`,
      sub: fail && tried.length ? `as ${tried.map((t) => `"${t}"`).join(', ')}` : '',
      cls, icon: ic,
    };
  }
  if (n > 1) {
    const paths = g.items.map(eventPath);
    const where = groupRoot(paths);
    const bytes = g.items.reduce((s, r) => s + (Number((String(r.detail).match(/\((\d+) bytes\)$/) || [])[1]) || 0), 0);
    return {
      text: `${who} ${verb} ${n} files`,
      sub: `${where === '/' ? 'Home' : where}${bytes ? ' · ' + fmtBytes(bytes) : ''}`,
      cls, icon: ic,
      items: g.items.map((r) => r.detail || ''),
    };
  }
  const r = g.items[0];
  let detail = r.detail || '';
  if (/login\.fail$/.test(g.action)) {
    const tried = (detail.match(/username=(\S+)/) || [])[1];
    return { text: g.action.startsWith('sftp') ? 'Failed SFTP sign-in' : 'Failed sign-in', sub: tried ? `as "${tried}"` : '', cls, icon: ic };
  }
  detail = detail.replace(/quota (\d+)\)/, (_, n) => `${fmtBytes(Number(n))} quota)`).replace(/^(\S+) \(user,/, '$1 (member,');
  const sizeMatch = detail.match(/ \((\d+) bytes\)$/);
  if (sizeMatch) detail = detail.replace(sizeMatch[0], ` · ${fmtBytes(Number(sizeMatch[1]))}`);
  const quotaMatch = detail.match(/-> (\d+) bytes$/);
  if (quotaMatch) detail = detail.replace(quotaMatch[0], `→ ${fmtBytes(Number(quotaMatch[1]))}`);
  detail = detail.replace(/ -> /, ' → ');
  return { text: `${who} ${verb}`, sub: detail, cls, icon: ic };
}

function initials(name) {
  return String(name || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}
