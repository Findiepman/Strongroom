'use strict';

// App shell: sticky header with the brand, the pill nav, search and the
// account menu. Every app page calls Shell.init(pageId) before rendering.
const Shell = {
  user: null,
  usage: { used: 0, quota: 0 },
  _busyCount: 0,
  _avatarBtn: null,
  onSearch: null, // the files page takes search over; other pages jump to /files?q=

  async init(pageId) {
    const user = await API.me();
    this.user = user;
    this.usage = { used: user.usedBytes, quota: user.quotaBytes };

    const nav = [
      { id: 'files', label: 'Home', icon: 'home', href: '/files' },
      { id: 'github', label: 'GitHub', icon: 'branch', href: '/github' },
      { id: 'sftp', label: 'SFTP', icon: 'server', href: '/sftp' },
      { id: 'settings', label: 'Settings', icon: 'settings', href: '/settings' },
    ];
    if (user.role === 'admin') nav.splice(3, 0, { id: 'admin', label: 'Admin', icon: 'shield', href: '/admin' });

    const pill = el('nav', { class: 'pillnav', 'aria-label': 'Main' },
      nav.map((n) => el('a', { href: n.href, ...(n.id === pageId ? { 'aria-current': 'page' } : {}) },
        icon(n.icon, 'sm'), n.label)));

    const searchInput = el('input', {
      type: 'search', id: 'global-search', placeholder: 'Search your files',
      autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search your files',
    });
    const search = el('label', { class: 'search' }, icon('search', 'sm'), searchInput, el('kbd', {}, '/'));
    searchInput.addEventListener('input', () => { if (this.onSearch) this.onSearch(searchInput.value, false); });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.onSearch) this.onSearch(searchInput.value, true);
        else if (searchInput.value.trim()) window.location.href = '/files?q=' + encodeURIComponent(searchInput.value.trim());
      } else if (e.key === 'Escape') {
        searchInput.value = '';
        searchInput.blur();
        if (this.onSearch) this.onSearch('', true);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        searchInput.focus();
      }
    });

    this._avatarBtn = el('button', {
      class: 'avatar-btn', 'aria-label': 'Account menu', 'aria-haspopup': 'menu',
      onclick: (e) => this.accountMenu(e.currentTarget),
    }, el('span', { class: 'avatar' }, initials(user.username), el('span', { class: 'busy-dot' })));

    const header = el('header', { class: 'hd' },
      el('a', { class: 'brand', href: '/files' }, el('span', { class: 'brand-mark' }, icon('vault')), 'Strongroom'),
      pill,
      el('div', { class: 'hd-right' }, search, this._avatarBtn));

    const content = document.getElementById('app');
    content.classList.add('page');
    document.body.prepend(header);

    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return user;
  },

  accountMenu(anchor) {
    const pct = this.usage.quota > 0 ? Math.min(100, (this.usage.used / this.usage.quota) * 100) : 0;
    openMenu(anchor, [
      el('div', { class: 'menu-head' },
        el('b', {}, this.user.username),
        el('small', {}, `${this.user.role === 'admin' ? 'Admin' : 'Member'} · ${fmtBytes(this.usage.used)} of ${fmtBytes(this.usage.quota)}`),
        el('div', { class: 'meter', style: 'margin-top:10px' }, el('i', { class: pct > 90 ? 'full' : '', style: `width:${pct.toFixed(1)}%` }))),
      el('hr'),
      el('a', { href: '/settings' }, icon('settings', 'sm'), 'Settings'),
      el('a', { href: '/sftp' }, icon('terminal', 'sm'), 'SFTP access'),
      el('hr'),
      el('button', { class: 'danger', onclick: () => Shell.logout() }, icon('logout', 'sm'), 'Sign out'),
    ], 'right');
  },

  // A request is in flight: spinner on the avatar.
  busy(on) {
    this._busyCount = Math.max(0, this._busyCount + (on ? 1 : -1));
    if (this._avatarBtn) this._avatarBtn.classList.toggle('is-busy', this._busyCount > 0);
  },

  updateGauge(used, quota) {
    if (used != null) this.usage.used = used;
    if (quota != null) this.usage.quota = quota;
  },

  setSearch(value) {
    const input = document.getElementById('global-search');
    if (input) input.value = value;
  },

  async logout() {
    try { await API.call('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
    window.location.href = '/';
  },
};

// Wrap an async action with the busy indicator.
async function withBusy(fn) {
  Shell.busy(true);
  try { return await fn(); } finally { Shell.busy(false); }
}

/* ---------- Popover menu ---------- */

let openMenuEl = null;
function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}
// Opens a menu next to anchor. align 'right' keeps it inside the viewport's right edge.
function openMenu(anchor, items, align = 'auto') {
  closeMenu();
  const menu = el('div', { class: 'menu', role: 'menu' }, items);
  menu.addEventListener('click', (e) => { if (e.target.closest('button, a')) closeMenu(); });
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  if (left + mw > window.innerWidth - 12) left = r.right - mw;
  left = Math.max(12, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  openMenuEl = menu;
  const first = menu.querySelector('button, a');
  if (first) first.focus({ preventScroll: true });
}
document.addEventListener('mousedown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);
window.addEventListener('scroll', closeMenu, { passive: true });

// Menu item helper: menuItem('edit', 'Rename', fn, {danger: true})
function menuItem(ic, label, onclick, opts = {}) {
  return el('button', { class: opts.danger ? 'danger' : '', role: 'menuitem', onclick }, icon(ic, 'sm'), label);
}
