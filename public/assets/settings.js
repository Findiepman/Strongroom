'use strict';

function renderUsage(used, quota) {
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  document.getElementById('usage-label').textContent = `${fmtBytes(used)} of ${fmtBytes(quota)}`;
  document.getElementById('usage-pct').textContent = pct.toFixed(1) + '%';
  const fill = document.getElementById('usage-fill');
  fill.style.width = pct.toFixed(1) + '%';
  fill.classList.toggle('full', pct > 90);
}

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('pw-error');
  const okEl = document.getElementById('pw-ok');
  errEl.textContent = '';
  okEl.textContent = '';
  const next = document.getElementById('pw-next').value;
  const repeat = document.getElementById('pw-repeat').value;
  if (next !== repeat) {
    errEl.textContent = 'The new passwords do not match';
    return;
  }
  try {
    await withBusy(() => API.call('/api/user/password', {
      method: 'POST',
      body: { current: document.getElementById('pw-current').value, next },
    }));
    okEl.textContent = 'Password changed. Other sessions have been signed out.';
    e.target.reset();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

(async () => {
  const user = await Shell.init('settings');

  const usage = await withBusy(() => API.call('/api/user/usage'));
  renderUsage(usage.usedBytes, usage.quotaBytes);
  Shell.updateGauge(usage.usedBytes, usage.quotaBytes);

  const kv = document.getElementById('account-kv');
  const rows = [
    ['username', user.username],
    ['role', user.role],
    ['quota', fmtBytes(user.quotaBytes)],
  ];
  for (const [k, v] of rows) {
    kv.append(el('dt', {}, k));
    kv.append(el('dd', {}, el('span', { class: 'val' }, v)));
  }
})();
