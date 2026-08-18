'use strict';

function copyBtn(getText) {
  return el('button', {
    class: 'btn-ghost',
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(getText());
        e.target.textContent = 'copied';
        setTimeout(() => { e.target.textContent = 'copy'; }, 1500);
      } catch {
        toast('Copy failed — select the text manually', true);
      }
    },
  }, 'copy');
}

(async () => {
  await Shell.init('sftp');
  const info = await withBusy(() => API.call('/api/sftp/info'));

  const led = document.getElementById('sftp-led');
  const status = document.getElementById('sftp-status');
  if (info.enabled) {
    led.classList.add('on');
    status.textContent = 'service up';
  } else {
    led.classList.add('err');
    status.textContent = 'disabled on the server';
  }

  const kv = document.getElementById('sftp-kv');
  const rows = [
    ['host', info.host],
    ['port', String(info.port)],
    ['username', info.username],
    ['protocol', 'SFTP (SSH file transfer)'],
    ['your directory', info.serverPath],
  ];
  for (const [k, v] of rows) {
    kv.append(el('dt', {}, k));
    kv.append(el('dd', {}, el('span', { class: 'val' }, v), copyBtn(() => v)));
  }

  document.getElementById('cmd-sftp').textContent =
    `sftp -P ${info.port} ${info.username}@${info.host}`;
  document.getElementById('cmd-client').textContent =
    [`Protocol:  SFTP`,
     `Host:      ${info.host}`,
     `Port:      ${info.port}`,
     `User:      ${info.username}`,
     `Password:  your strongroom password`].join('\n');
})();
