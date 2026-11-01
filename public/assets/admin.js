'use strict';

const GB = 1024 * 1024 * 1024;
const $ = (id) => document.getElementById(id);

/* ---------- Confirm dialog ---------- */

const confirmDialog = $('confirm-dialog');
let confirmAction = null;
function confirmDanger(title, text, okLabel, action) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  confirmAction = action;
  confirmDialog.showModal();
}
$('confirm-cancel').addEventListener('click', () => confirmDialog.close());
$('confirm-ok').addEventListener('click', async () => {
  confirmDialog.close();
  if (confirmAction) await confirmAction();
});

/* ---------- Accounts ---------- */

async function patchUser(u, body, okText) {
  try {
    await withBusy(() => API.call(`/api/admin/users/${u.id}`, { method: 'PATCH', body }));
    toast(okText);
    await loadUsers();
  } catch (err) { toast(err.message, true); }
}

function accountCard(u) {
  const isSelf = u.id === Shell.user.id;
  const pct = u.quota_bytes > 0 ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0;

  const quotaInput = el('input', {
    type: 'number', value: String(Math.round(u.quota_bytes / GB)), min: '1', step: '1',
    'aria-label': `Quota for ${u.username} in GB`,
  });
  const saveBtn = el('button', { class: 'btn sm', hidden: '' }, 'Save');
  quotaInput.addEventListener('input', () => { saveBtn.hidden = Number(quotaInput.value) === Math.round(u.quota_bytes / GB); });
  const saveQuota = () => {
    const gb = Number(quotaInput.value);
    if (!(gb > 0)) { toast('Quota must be at least 1 GB', true); return; }
    patchUser(u, { quotaBytes: Math.floor(gb * GB) }, `${u.username} now has ${gb} GB`);
  };
  saveBtn.addEventListener('click', saveQuota);
  quotaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveQuota(); });

  const menuBtn = el('button', { class: 'icon-btn', 'aria-label': `More for ${u.username}`, 'aria-haspopup': 'menu' }, icon('more'));
  menuBtn.addEventListener('click', () => {
    const items = [
      menuItem('logout', 'Sign out everywhere', () => confirmDanger(
        'Sign out everywhere?',
        `Ends all ${u.active_sessions} active session${u.active_sessions === 1 ? '' : 's'} for ${u.username}${isSelf ? ', including this one' : ''}.`,
        'Sign out', async () => {
          try {
            await API.call(`/api/admin/users/${u.id}/logout`, { method: 'POST' });
            if (isSelf) { window.location.href = '/'; return; }
            toast(`${u.username} has been signed out everywhere`);
            await loadUsers();
          } catch (err) { toast(err.message, true); }
        })),
    ];
    if (!isSelf) {
      items.unshift(u.role === 'admin'
        ? menuItem('user', 'Make member', () => patchUser(u, { role: 'user' }, `${u.username} is now a member`))
        : menuItem('shield', 'Make admin', () => confirmDanger('Make admin?', `${u.username} gets full control: accounts, quotas and the audit log.`, 'Make admin',
          () => patchUser(u, { role: 'admin' }, `${u.username} is now an admin`))));
      items.push(el('hr'), menuItem('trash', 'Delete account', () => confirmDanger(
        `Delete ${u.username}?`,
        'The account and its sessions are removed. Their files stay on disk under the storage root, so nothing is lost by accident.',
        'Delete account', async () => {
          try {
            await API.call(`/api/admin/users/${u.id}`, { method: 'DELETE' });
            toast(`Deleted ${u.username}`);
            await loadUsers();
          } catch (err) { toast(err.message, true); }
        }), { danger: true }));
    }
    openMenu(menuBtn, items, 'right');
  });

  return el('div', { class: 'acc' },
    el('div', { class: 'acc-top' },
      el('span', { class: 'avatar' }, initials(u.username)),
      el('div', { class: 'who' },
        el('b', {}, u.username, isSelf ? el('span', { class: 'badge' }, 'you') : null),
        el('small', {}, `Joined ${relTime(u.created_at)}`)),
      el('span', { class: 'badge' + (u.role === 'admin' ? ' ac' : '') }, u.role === 'admin' ? 'admin' : 'member'),
      menuBtn),
    el('div', {},
      el('div', { class: 'acc-use' }, el('span', {}, el('b', {}, fmtBytes(u.used_bytes)), ` of ${fmtBytes(u.quota_bytes)}`), el('span', {}, `${pct.toFixed(pct < 10 ? 1 : 0)}%`)),
      el('div', { class: 'meter' }, el('i', { class: pct > 90 ? 'full' : '', style: `width:${pct.toFixed(1)}%` }))),
    el('div', { class: 'acc-foot' },
      el('div', { class: 'quota-edit' }, el('span', {}, 'Quota'), quotaInput, el('span', {}, 'GB'), saveBtn),
      el('span', { class: 'badge' + (u.active_sessions > 0 ? ' ok' : '') },
        u.active_sessions > 0 ? `${u.active_sessions} online` : 'offline')));
}

async function loadUsers() {
  const data = await withBusy(() => API.call('/api/admin/users'));
  const box = $('accounts');
  box.textContent = '';
  data.users.forEach((u) => box.append(accountCard(u)));

  const users = data.users;
  $('st-accounts').textContent = users.length;
  const admins = users.filter((u) => u.role === 'admin').length;
  $('st-admins').textContent = `${admins} admin${admins === 1 ? '' : 's'}`;
  $('st-sessions').textContent = users.reduce((n, u) => n + u.active_sessions, 0);
  $('st-used').textContent = fmtBytes(users.reduce((n, u) => n + u.used_bytes, 0));
  $('st-quota').textContent = fmtBytes(users.reduce((n, u) => n + u.quota_bytes, 0));
}

/* ---------- Create account ---------- */

const createDialog = $('create-dialog');
$('new-account-btn').addEventListener('click', () => {
  $('create-form').reset();
  $('new-quota').value = '10';
  $('create-error').textContent = '';
  createDialog.showModal();
});
$('create-cancel').addEventListener('click', () => createDialog.close());
$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('create-error').textContent = '';
  const username = $('new-username').value.trim();
  try {
    await withBusy(() => API.call('/api/admin/users', {
      method: 'POST',
      body: {
        username,
        password: $('new-password').value,
        role: $('new-role').value,
        quotaBytes: Math.floor(Number($('new-quota').value) * GB),
      },
    }));
    createDialog.close();
    toast(`Account ${username} created`);
    await loadUsers();
    await loadAudit(true);
  } catch (err) {
    $('create-error').textContent = err.message;
  }
});

/* ---------- Audit log ---------- */

const FILTERS = [
  { id: 'all', label: 'All', actions: '' },
  { id: 'auth', label: 'Sign-ins', icon: 'lock', actions: 'login.success,login.fail,logout,sftp.login,sftp.login.fail' },
  { id: 'files', label: 'Files', icon: 'folder', actions: 'upload,sftp.upload,download,download.zip,mkdir,rename,repo.pull' },
  { id: 'deletes', label: 'Deletes', icon: 'trash', actions: 'delete,sftp.delete' },
  { id: 'admin', label: 'Admin', icon: 'shield', actions: 'user.create,user.delete,user.force_logout,quota.set,role.set,password.change' },
  { id: 'problems', label: 'Problems', icon: 'x', actions: 'login.fail,sftp.login.fail,upload.blocked,password.fail' },
];
const audit = { filter: 'all', rows: [], total: 0, limit: 200 };

const chipsBox = $('audit-chips');
for (const f of FILTERS) {
  const b = el('button', { class: 'chip', 'aria-pressed': String(f.id === audit.filter) }, f.icon ? icon(f.icon, 'sm') : null, f.label);
  b.addEventListener('click', () => {
    audit.filter = f.id;
    chipsBox.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    loadAudit(true);
  });
  chipsBox.append(b);
}

function renderAudit() {
  const list = $('audit-list');
  list.textContent = '';
  const groups = groupEvents(audit.rows);
  if (!groups.length) {
    list.append(el('p', { class: 'ev-empty' }, 'Nothing logged for this filter.'));
  }
  for (const g of groups) {
    const d = describeGroup(g);
    const when = el('span', { class: 'when', title: fmtDate(g.created_at) }, relTime(g.created_at));
    const line = (extra) => el('div', { class: 'ev' },
      el('span', { class: 'ek ' + d.cls }, icon(d.icon, 'sm')),
      el('div', { class: 'ev-body' }, el('span', {}, d.text), d.sub ? el('small', {}, d.sub) : null),
      extra, when);
    if (d.items) {
      list.append(el('details', { class: 'ev-group' },
        el('summary', {}, line(icon('chev', 'sm chev'))),
        el('div', { class: 'ev-items' }, d.items.map((t) => el('div', {}, t)))));
    } else {
      list.append(line(null));
    }
  }
  $('audit-count').textContent = `${audit.rows.length} of ${audit.total} events`;
  $('audit-more').hidden = audit.rows.length >= audit.total;
}

async function loadAudit(reset) {
  if (reset) audit.rows = [];
  const params = new URLSearchParams({ limit: audit.limit, offset: audit.rows.length });
  const f = FILTERS.find((x) => x.id === audit.filter);
  if (f.actions) params.set('action', f.actions);
  const user = $('audit-user').value.trim();
  if (user) params.set('user', user);
  try {
    const data = await withBusy(() => API.call('/api/admin/audit?' + params));
    audit.total = data.total;
    audit.rows.push(...data.rows);
    renderAudit();
  } catch (err) {
    toast(err.message, true);
  }
}

$('audit-more').addEventListener('click', () => loadAudit(false));
let auditUserTimer = null;
$('audit-user').addEventListener('input', () => {
  clearTimeout(auditUserTimer);
  auditUserTimer = setTimeout(() => loadAudit(true), 350);
});

/* ---------- Init ---------- */

(async () => {
  const user = await Shell.init('admin');
  if (user.role !== 'admin') { window.location.href = '/files'; return; }
  hydrateIcons();
  await loadUsers();
  await loadAudit(true);
  if (location.hash === '#audit') $('audit').scrollIntoView();
})();
