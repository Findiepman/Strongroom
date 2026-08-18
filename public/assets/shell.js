'use strict';

// App shell: left rail + topbar with the prompt line (the signature element).
// Every app page calls Shell.init(pageId) and gets back prompt + busy controls.
const Shell = {
  user: null,
  _cursor: null,
  _promptPath: null,
  _busyCount: 0,

  async init(pageId) {
    const user = await API.me();
    this.user = user;

    const nav = [
      { id: 'files', label: 'Files', href: '/files' },
      { id: 'github', label: 'GitHub puller', href: '/github' },
      { id: 'sftp', label: 'SFTP', href: '/sftp' },
      { id: 'settings', label: 'Settings', href: '/settings' },
    ];
    if (user.role === 'admin') nav.splice(3, 0, { id: 'admin', label: 'Admin', href: '/admin' });

    const railNav = el('nav', { class: 'nav', 'aria-label': 'Main' },
      nav.map((n) => el('a', { href: n.href, ...(n.id === pageId ? { 'aria-current': 'page' } : {}) }, n.label)));

    const gauge = el('div', { class: 'gauge', id: 'shell-gauge' },
      el('div', { class: 'gauge-nums' },
        el('span', {}, 'storage'),
        el('span', { id: 'gauge-label' }, '…')),
      el('div', { class: 'gauge-track' }, el('div', { class: 'gauge-fill', id: 'gauge-fill' })));

    const rail = el('aside', { class: 'rail' },
      el('a', { class: 'wordmark', href: '/files' }, 'strongroom'),
      railNav,
      el('div', { class: 'rail-foot' },
        gauge,
        el('div', { class: 'whoami' },
          el('span', {}, user.username),
          el('button', { class: 'btn-ghost', onclick: () => Shell.logout() }, 'sign out'))));

    const scrim = el('div', { class: 'rail-scrim', onclick: () => document.body.classList.remove('rail-open') });

    this._cursor = el('span', { class: 'cursor', 'aria-hidden': 'true' });
    this._promptPath = el('span', { class: 'p-path' });
    const prompt = el('div', { class: 'prompt', 'aria-label': 'Location' },
      el('span', { class: 'p-user' }, `${user.username}@strongroom`),
      el('span', { class: 'p-sep' }, ':'),
      this._promptPath,
      this._cursor);

    const menuBtn = el('button', {
      class: 'menu-btn', 'aria-label': 'Menu',
      onclick: () => document.body.classList.toggle('rail-open'),
    }, '≡');

    const topbar = el('header', { class: 'topbar' },
      el('div', { class: 'row', style: 'flex-wrap: nowrap; min-width: 0;' }, menuBtn, prompt),
      el('div', { id: 'topbar-actions', class: 'row' }));

    const content = document.getElementById('app');
    content.classList.add('content');
    const main = el('div', { style: 'min-width: 0;' }, topbar, content.parentNode.removeChild(content));

    const frame = el('div', { class: 'frame' }, rail, main);
    document.body.prepend(scrim);
    document.body.prepend(frame);

    this.updateGauge(user.usedBytes, user.quotaBytes);
    this.setPrompt([{ label: '~' }, { label: pageId }]);
    return user;
  },

  // segments: [{label, onclick?}] rendered as ~/a/b after user@strongroom:
  setPrompt(segments) {
    this._promptPath.textContent = '';
    segments.forEach((seg, i) => {
      if (i > 0) this._promptPath.append(el('span', { class: 'p-sep' }, '/'));
      if (seg.onclick) {
        this._promptPath.append(el('a', {
          class: 'p-seg', href: '#',
          onclick: (e) => { e.preventDefault(); seg.onclick(); },
        }, seg.label));
      } else {
        this._promptPath.append(el('span', { class: 'p-seg current' }, seg.label));
      }
    });
  },

  // Solid cursor = idle, hollow = a request in flight.
  busy(on) {
    this._busyCount = Math.max(0, this._busyCount + (on ? 1 : -1));
    this._cursor.classList.toggle('busy', this._busyCount > 0);
  },

  updateGauge(used, quota) {
    const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
    const fill = document.getElementById('gauge-fill');
    fill.style.width = pct.toFixed(1) + '%';
    fill.classList.toggle('full', pct > 90);
    document.getElementById('gauge-label').textContent = `${fmtBytes(used)} / ${fmtBytes(quota)}`;
  },

  topbarActions(...nodes) {
    const slot = document.getElementById('topbar-actions');
    slot.textContent = '';
    slot.append(...nodes);
  },

  async logout() {
    try { await API.call('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
    window.location.href = '/';
  },
};

// Wrap an async action with the busy cursor.
async function withBusy(fn) {
  Shell.busy(true);
  try { return await fn(); } finally { Shell.busy(false); }
}
