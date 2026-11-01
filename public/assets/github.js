'use strict';

const logPane = document.getElementById('log-pane');
const repoList = document.getElementById('repo-list');
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

async function pull(url) {
  const errEl = document.getElementById('pull-error');
  errEl.textContent = '';
  if (!url) { errEl.textContent = 'Paste a repository URL first'; return; }
  try {
    const data = await API.call('/api/github/repos', { method: 'POST', body: { url } });
    logPane.textContent = '';
    logLine(`${data.op === 'clone' ? 'Cloning' : 'Pulling'} ${data.repo}`);
    watchJob(data.jobId);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

document.getElementById('pull-form').addEventListener('submit', (e) => {
  e.preventDefault();
  pull(document.getElementById('repo-url').value.trim());
});

async function loadRepos() {
  try {
    const data = await API.call('/api/github/repos');
    repoList.textContent = '';
    repoEmpty.hidden = data.repos.length > 0;
    repoEmpty.textContent = '';
    if (!data.repos.length) repoEmpty.append(icon('branch'), el('b', {}, 'No repositories yet'), 'Pull one with the form.');
    document.getElementById('repo-count').textContent = data.repos.length ? `${data.repos.length} repo${data.repos.length === 1 ? '' : 's'}` : '';
    for (const r of data.repos) {
      const fi = el('span', { class: 'fi' }, icon('branch'));
      repoList.append(el('div', { class: 'repo' },
        fi,
        el('div', { class: 'meta' },
          el('b', {}, r.name),
          el('small', {}, el('span', { class: 'live-dot' + (r.running ? ' on' : '') }), r.running ? ' pulling now' : ` updated ${relTime(r.mtime)}`)),
        el('div', { class: 'acts' },
          r.hasIndex ? el('a', { class: 'btn sm', href: '/live/' + encodeURIComponent(r.name) + '/', target: '_blank', rel: 'noopener' }, icon('external', 'sm'), 'Live') : null,
          el('a', { class: 'btn sm', href: '/files?path=' + encodeURIComponent('/repos/' + r.name) }, icon('folder', 'sm'), 'Browse'))));
      if (r.running && r.jobId && !eventSource) watchJob(r.jobId);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

(async () => {
  await Shell.init('github');
  hydrateIcons();
  await loadRepos();
})();
