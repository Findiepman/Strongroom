'use strict';

const GB = 1024 * 1024 * 1024;
const userRows = document.getElementById('user-rows');
const auditRows = document.getElementById('audit-rows');
const auditState = { offset: 0, limit: 50, total: 0 };

/* ---------- Confirm dialog ---------- */

const confirmDialog = document.getElementById('confirm-dialog');
let confirmAction = null;
function confirmDanger(title, text, action) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  confirmAction = action;
  confirmDialog.showModal();
}
document.getElementById('confirm-cancel').addEventListener('click', () => confirmDialog.close());
document.getElementById('confirm-ok').addEventListener('click', async () => {
  confirmDialog.close();
  if (confirmAction) await confirmAction();
});

/* ---------- Users ---------- */

async function loadUsers() {
  const data = await withBusy(() => API.call('/api/admin/users'));
  userRows.textContent = '';
  for (const u of data.users) {
    const quotaInput = el('input', {
      type: 'number', value: (u.quota_bytes / GB).toFixed(0), min: '1', step: '1',
      style: 'width: 80px', 'aria-label': `Quota for ${u.username}`,
    });
    const saveBtn = el('button', {
      class: 'btn-ghost',
      onclick: async () => {
        try {
          await API.call(`/api/admin/users/${u.id}`, {
            method: 'PATCH',
            body: { quotaBytes: Math.floor(Number(quotaInput.value) * GB) },
          });
          toast(`Quota for ${u.username} set to ${quotaInput.value} GB`);
          await loadUsers();
        } catch (err) { toast(err.message, true); }
      },
    }, 'save');

    const isSelf = u.id === Shell.user.id;
    userRows.append(el('tr', {},
      el('td', { class: 'mono' }, u.username, isSelf ? el('span', { class: 'tag', style: 'margin-left:8px' }, 'you') : null),
      el('td', {}, el('span', { class: 'tag' + (u.role === 'admin' ? ' amber' : '') }, u.role)),
      el('td', { class: 'num' }, fmtBytes(u.used_bytes)),
      el('td', {}, el('div', { class: 'row', style: 'flex-wrap:nowrap' }, quotaInput, saveBtn)),
      el('td', { class: 'num optional' }, String(u.active_sessions)),
      el('td', { class: 'actions' }, el('div', { class: 'row', style: 'flex-wrap:nowrap; justify-content:flex-end' },
        el('button', {
          class: 'btn-ghost',
          onclick: () => confirmDanger('Force logout', `End all ${u.active_sessions} active sessions for ${u.username}?`, async () => {
            try {
              await API.call(`/api/admin/users/${u.id}/logout`, { method: 'POST' });
              toast(`${u.username} has been signed out everywhere`);
              await loadUsers();
            } catch (err) { toast(err.message, true); }
          }),
        }, 'kick'),
        isSelf ? null : el('button', {
          class: 'btn-ghost danger',
          onclick: () => confirmDanger('Delete account', `Delete ${u.username}? Their files stay on disk under the storage root.`, async () => {
            try {
              await API.call(`/api/admin/users/${u.id}`, { method: 'DELETE' });
              toast(`Deleted ${u.username}`);
              await loadUsers();
            } catch (err) { toast(err.message, true); }
          }),
        }, 'del')))));
  }
}

/* ---------- Create user ---------- */

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('create-error');
  errEl.textContent = '';
  try {
    await withBusy(() => API.call('/api/admin/users', {
      method: 'POST',
      body: {
        username: document.getElementById('new-username').value.trim(),
        password: document.getElementById('new-password').value,
        role: document.getElementById('new-role').value,
        quotaBytes: Math.floor(Number(document.getElementById('new-quota').value) * GB),
      },
    }));
    toast(`Account ${document.getElementById('new-username').value.trim()} created`);
    e.target.reset();
    document.getElementById('new-quota').value = '10';
    await loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

/* ---------- Audit log ---------- */

async function loadAudit(reset) {
  if (reset) {
    auditState.offset = 0;
    auditRows.textContent = '';
  }
  const params = new URLSearchParams({ limit: auditState.limit, offset: auditState.offset });
  const action = document.getElementById('audit-action').value;
  const user = document.getElementById('audit-user').value.trim();
  if (action) params.set('action', action);
  if (user) params.set('user', user);
  const data = await withBusy(() => API.call('/api/admin/audit?' + params));
  auditState.total = data.total;
  auditState.offset += data.rows.length;
  for (const r of data.rows) {
    const isFail = /fail|blocked/.test(r.action);
    auditRows.append(el('tr', {},
      el('td', { class: 'num' }, fmtDate(r.created_at)),
      el('td', { class: 'mono' }, r.username || '-'),
      el('td', {}, el('span', { class: 'tag' + (isFail ? ' red' : '') }, r.action)),
      el('td', { class: 'mono', style: 'white-space:normal; word-break:break-all; font-size:12px; color:var(--muted)' }, r.detail || ''),
      el('td', { class: 'num optional' }, r.ip || '-')));
  }
  document.getElementById('audit-count').textContent = `${auditState.offset} of ${auditState.total}`;
  document.getElementById('audit-more').disabled = auditState.offset >= auditState.total;
}

document.getElementById('audit-more').addEventListener('click', () => loadAudit(false));
document.getElementById('audit-action').addEventListener('change', () => loadAudit(true));
let auditUserTimer = null;
document.getElementById('audit-user').addEventListener('input', () => {
  clearTimeout(auditUserTimer);
  auditUserTimer = setTimeout(() => loadAudit(true), 350);
});

/* ---------- Init ---------- */

(async () => {
  const user = await Shell.init('admin');
  if (user.role !== 'admin') { window.location.href = '/files'; return; }
  await loadUsers();
  await loadAudit(true);
})();
