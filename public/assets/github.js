'use strict';

const logPane = document.getElementById('log-pane');
const repoRows = document.getElementById('repo-rows');
const repoEmpty = document.getElementById('repo-empty');
const pullBtn = document.getElementById('pull-btn');
let eventSource = null;

function logLine(text, cls) {
  const t = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  logPane.append(el('div', { class: cls || '' },
    el('span', { class: 't' }, `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`),
    text));
  logPane.scrollTop = logPane.scrollHeight;
}

function watchJob(jobId) {
  if (eventSource) eventSource.close();
  logPane.hidden = false;
  Shell.busy(true);
  pullBtn.disabled = true;
  eventSource = new EventSource(`/api/github/jobs/${jobId}/events`);
  eventSource.addEventListener('line', (e) => {
    const data = JSON.parse(e.data);
    logLine(data.text);
  });
  eventSource.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    logLine(data.status === 'done' ? 'Finished' : 'Failed', data.status === 'done' ? 'done' : 'fail');
    eventSource.close();
    eventSource = null;
    Shell.busy(false);
    pullBtn.disabled = false;
    loadRepos();
  });
  eventSource.onerror = () => {
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      logLine('Lost the live log stream. The pull may still be running, refresh to check.', 'fail');
      Shell.busy(false);
      pullBtn.disabled = false;
    }
  };
}

document.getElementById('pull-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('pull-error');
  errEl.textContent = '';
  const url = document.getElementById('repo-url').value.trim();
  if (!url) { errEl.textContent = 'Paste a repository URL first'; return; }
  try {
    const data = await API.call('/api/github/repos', { method: 'POST', body: { url } });
    logPane.textContent = '';
    logLine(`${data.op === 'clone' ? 'Cloning' : 'Pulling'} ${data.repo}`);
    watchJob(data.jobId);
  } catch (err) {
    if (err.status === 409 && err.message.includes('already running')) {
      errEl.textContent = err.message;
    } else {
      errEl.textContent = err.message;
    }
  }
});

async function loadRepos() {
  try {
    const data = await API.call('/api/github/repos');
    repoRows.textContent = '';
    repoEmpty.hidden = data.repos.length > 0;
    for (const r of data.repos) {
      repoRows.append(el('tr', {},
        el('td', { class: 'mono' }, r.name),
        el('td', {}, el('div', { class: 'row', style: 'flex-wrap:nowrap' },
          el('span', { class: 'led' + (r.running ? ' on' : '') }),
          el('span', { class: 'mono', style: 'font-size:12px; color:var(--muted)' }, r.running ? 'pulling' : 'idle'))),
        el('td', { class: 'num optional' }, fmtDate(r.mtime)),
        el('td', { class: 'actions' },
          el('a', {
            class: 'btn-ghost', style: 'text-decoration:none',
            href: '/files?path=' + encodeURIComponent('/repos/' + r.name),
          }, 'browse'))));
      if (r.running && r.jobId && !eventSource) watchJob(r.jobId);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

(async () => {
  await Shell.init('github');
  await loadRepos();
})();
