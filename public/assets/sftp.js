'use strict';

function copyBtn(getText, label) {
  const b = el('button', { class: 'icon-btn', 'aria-label': `Copy ${label}`, title: 'Copy' }, icon('copy', 'sm'));
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.replaceChildren(icon('check', 'sm'));
      setTimeout(() => b.replaceChildren(icon('copy', 'sm')), 1500);
    } catch {
      toast('Copy failed. Select the text manually.', true);
    }
  });
  return b;
}

(async () => {
  await Shell.init('sftp');
  const info = await withBusy(() => API.call('/api/sftp/info'));

  const dot = document.getElementById('sftp-dot');
  const status = document.getElementById('sftp-status');
  dot.classList.toggle('on', !!info.enabled);
  status.textContent = info.enabled ? 'Service running' : 'Turned off on the server';

  const kv = document.getElementById('sftp-kv');
  const rows = [
    ['Host', info.host],
    ['Port', String(info.port)],
    ['Username', info.username],
    ['Protocol', 'SFTP (SSH file transfer)'],
    ['Your folder', info.serverPath],
  ];
  for (const [k, v] of rows) {
    kv.append(el('dt', {}, k));
    kv.append(el('dd', {}, el('span', { class: 'val', title: v }, v), copyBtn(() => v, k.toLowerCase())));
  }

  const cmd = `sftp -P ${info.port} ${info.username}@${info.host}`;
  const client = [`Protocol:  SFTP`, `Host:      ${info.host}`, `Port:      ${info.port}`, `User:      ${info.username}`, `Password:  your Strongroom password`].join('\n');
  document.getElementById('cmd-sftp').textContent = cmd;
  document.getElementById('cmd-client').textContent = client;
  document.getElementById('cmd-sftp').parentNode.append(copyBtn(() => cmd, 'command'));
  document.getElementById('cmd-client').parentNode.append(copyBtn(() => client, 'client settings'));
})();
