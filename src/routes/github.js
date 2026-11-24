'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const config = require('../config');
const { audit } = require('../db');
const { requireAuth, csrfProtect } = require('../middleware/auth');
const { sizeOf } = require('../util/usage');

const router = express.Router();
router.use(requireAuth, csrfProtect);

const GITHUB_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const ANY_HTTPS_RE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+?(?:\.git)?\/?$/;

const jobs = new Map(); // id -> job
const gitLogPath = path.join(config.LOG_DIR, 'git.log');

// Git output is never forwarded verbatim: only recognized progress shapes are
// translated into our own lines. Everything else goes to the server log file.
function sanitizeGitLine(raw) {
  const line = String(raw).replace(/\r/g, '').trim();
  if (!line) return null;
  let m;
  if (/^Cloning into /.test(line)) return 'Cloning repository';
  if ((m = line.match(/^(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Unpacking objects|Updating files):\s+(\d+)%/))) {
    return `${m[1]}: ${m[2]}%`;
  }
  if (/^Already up to date/i.test(line)) return 'Already up to date';
  if (/^Fast-forward/.test(line)) return 'Fast-forwarding to latest';
  if ((m = line.match(/^Updating ([0-9a-f]{7,40})\.\.+([0-9a-f]{7,40})$/))) {
    return `Updating ${m[1].slice(0, 7)} to ${m[2].slice(0, 7)}`;
  }
  if ((m = line.match(/^(\d+) files? changed/))) return line.split(',')[0];
  return null;
}

function friendlyError(exitCode, rawOutput) {
  if (/Repository not found|fatal: repository .+ not found/i.test(rawOutput)) return 'Repository not found. Check the URL, private repos are not supported.';
  if (/could not resolve host|unable to access/i.test(rawOutput)) return 'Could not reach the git host. Check the server\'s network connection.';
  if (/Authentication failed|could not read Username|Permission denied/i.test(rawOutput)) return 'The repository requires authentication. Only public repos are supported.';
  if (/not a git repository/i.test(rawOutput)) return 'The target folder exists but is not a git repository. Remove it and pull again.';
  if (/Not possible to fast-forward|divergent/i.test(rawOutput)) return 'The local copy has diverged from the remote. Remove the folder and pull fresh.';
  if (exitCode === null) return 'The operation timed out and was stopped.';
  return 'git exited with an error. Details are in the server log.';
}

const GiB = 1024 * 1024 * 1024;
function formatBytes(n) {
  if (n >= GiB) return `${+(n / GiB).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

// Why a new clone/pull may not start, or null. Every running job may still
// grow to the per-repo limit, so they count at that worst case: otherwise many
// clones started at once would each see the same free space.
function repoCapError({ totalBytes, runningJobs, maxRepoBytes, maxTotalBytes }) {
  if (totalBytes >= maxTotalBytes) {
    return `Repository storage is full (${formatBytes(totalBytes)} of ${formatBytes(maxTotalBytes)}). Remove a repository first.`;
  }
  if (runningJobs > 0 && totalBytes + runningJobs * maxRepoBytes >= maxTotalBytes) {
    return 'Repository storage is nearly full. Wait for the running pulls to finish and try again.';
  }
  return null;
}

// Checks the size of `dir` every intervalMs while git runs and calls
// onOver(bytes) once when it passes maxBytes. The walk is async and the next
// check is only scheduled after the last one finished, so a big tree never
// blocks the server or piles up walks. Returns a stop function.
function watchSize(dir, maxBytes, onOver, intervalMs = 2000) {
  let stopped = false;
  let timer = null;
  const tick = async () => {
    const bytes = await sizeOf(dir);
    if (stopped) return;
    if (bytes > maxBytes) {
      stopped = true;
      onOver(bytes);
      return;
    }
    timer = setTimeout(tick, intervalMs);
    timer.unref();
  };
  timer = setTimeout(tick, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function pushLine(job, text) {
  const entry = { t: Date.now(), text };
  job.lines.push(entry);
  if (job.lines.length > 500) job.lines.shift();
  for (const listener of job.listeners) listener(entry);
}

function startJob({ url, repoName, op, dest, user, ip }) {
  const id = crypto.randomUUID();
  const job = { id, repo: repoName, op, status: 'running', lines: [], listeners: new Set(), startedAt: Date.now() };
  jobs.set(id, job);

  // core.symlinks=false: git writes a repo's symlinks as small plain files
  // holding the target path instead of real links, so a repo can't link to
  // files elsewhere on the server. --config stores it in the clone's own
  // config for later pulls; -c covers repos cloned before this was set.
  const args = op === 'clone'
    ? ['-c', 'core.symlinks=false', 'clone', '--config', 'core.symlinks=false', '--progress', '--', url, dest]
    : ['-C', dest, '-c', 'core.symlinks=false', 'pull', '--ff-only', '--progress'];

  const child = spawn('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let rawOutput = '';
  const timer = setTimeout(() => {
    pushLine(job, 'Timed out, stopping git');
    child.kill('SIGKILL');
  }, config.GIT_TIMEOUT_MS);

  let oversize = 0; // bytes on disk when the size limit was hit
  const stopWatch = watchSize(dest, config.REPO_MAX_BYTES, (bytes) => {
    oversize = bytes;
    pushLine(job, `Repository passed the ${formatBytes(config.REPO_MAX_BYTES)} size limit, stopping git`);
    child.kill('SIGKILL');
  });
  const tooBigLine = () => (op === 'clone'
    ? `This repository is bigger than the ${formatBytes(config.REPO_MAX_BYTES)} limit. The partial copy was removed.`
    : `This repository is now bigger than the ${formatBytes(config.REPO_MAX_BYTES)} limit. Ask an admin to remove it.`);

  let lastPct = {};
  const onData = (buf) => {
    const text = buf.toString('utf8');
    rawOutput += text.slice(0, 4000);
    for (const rawLine of text.split(/[\r\n]+/)) {
      const clean = sanitizeGitLine(rawLine);
      if (!clean) continue;
      // Progress lines repeat per percent; only forward meaningful steps.
      const m = clean.match(/^(.+): (\d+)%$/);
      if (m) {
        const pct = parseInt(m[2], 10);
        if (lastPct[m[1]] !== undefined && pct - lastPct[m[1]] < 10 && pct !== 100) continue;
        lastPct[m[1]] = pct;
      }
      pushLine(job, clean);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', () => {
    clearTimeout(timer);
    stopWatch();
    job.status = 'failed';
    pushLine(job, 'git is not installed on the server');
    finish();
  });

  // This runs in an async handler: a throw here would be an unhandled
  // rejection, so a folder that can't be removed is only logged.
  const removePartial = () => {
    try {
      fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.error('[github] could not remove partial clone', dest, err.message);
    }
  };

  child.on('close', async (code) => {
    clearTimeout(timer);
    stopWatch();
    // A small repo can finish between two checks: measure once more at the end.
    if (!oversize && code === 0) {
      const bytes = await sizeOf(dest);
      if (bytes > config.REPO_MAX_BYTES) oversize = bytes;
    }
    try {
      fs.appendFileSync(gitLogPath, `\n--- ${new Date().toISOString()} ${op} ${repoName} by ${user.username} (exit ${code}) ---\n${rawOutput}\n`);
    } catch { /* log write is best-effort */ }
    if (job.status === 'running') {
      if (oversize) {
        job.status = 'failed';
        pushLine(job, tooBigLine());
        if (op === 'clone') removePartial();
        // git was killed mid-pull: drop its lock so the next pull can run.
        else fs.rm(path.join(dest, '.git', 'index.lock'), { force: true }, () => {});
      } else if (code === 0) {
        job.status = 'done';
        pushLine(job, op === 'clone' ? 'Clone complete' : 'Pull complete');
      } else {
        job.status = 'failed';
        pushLine(job, friendlyError(code, rawOutput));
        if (op === 'clone') removePartial();
      }
    }
    audit({ userId: user.id, username: user.username, action: 'repo.pull', detail: `${op} ${repoName}: ${job.status}`, ip });
    finish();
  });

  function finish() {
    for (const listener of job.listeners) listener(null, job.status);
    // Keep finished jobs around briefly so late SSE connects can replay.
    setTimeout(() => jobs.delete(id), 10 * 60 * 1000).unref();
  }

  return job;
}

// POST /api/github/repos {url}
router.post('/repos', async (req, res, next) => {
  const { url } = req.body || {};
  if (typeof url !== 'string' || url.length > 300) {
    return res.status(400).json({ error: 'Paste a repository URL' });
  }
  const re = config.GIT_ALLOW_ANY_HTTPS_HOST ? ANY_HTTPS_RE : GITHUB_URL_RE;
  const m = url.trim().match(re);
  if (!m) {
    return res.status(400).json({ error: 'Use an https://github.com/owner/repo URL' });
  }
  const repoName = decodeURIComponent(url.trim().replace(/\/+$/, '').split('/').pop()).replace(/\.git$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(repoName) || repoName === '.' || repoName === '..') {
    return res.status(400).json({ error: 'Repository name contains unsupported characters' });
  }
  const dest = path.resolve(config.REPOS_ROOT, repoName);
  if (!dest.startsWith(path.resolve(config.REPOS_ROOT) + path.sep)) {
    return res.status(400).json({ error: 'Repository name is not allowed' });
  }

  // Repos don't count toward anyone's quota, so they get their own caps.
  let totalBytes;
  try {
    totalBytes = await sizeOf(config.REPOS_ROOT);
  } catch (err) {
    return next(err);
  }
  const capError = repoCapError({
    totalBytes,
    runningJobs: [...jobs.values()].filter((j) => j.status === 'running').length,
    maxRepoBytes: config.REPO_MAX_BYTES,
    maxTotalBytes: config.REPOS_MAX_TOTAL_BYTES,
  });
  if (capError) return res.status(507).json({ error: capError });

  // Express 4 doesn't catch a throw after an await: pass it on by hand.
  try {
    startAfterChecks(req, res, { url, repoName, dest });
  } catch (err) {
    next(err);
  }
});

function startAfterChecks(req, res, { url, repoName, dest }) {
  // Checked after the await above, so two quick requests can't both start.
  const running = [...jobs.values()].find((j) => j.repo === repoName && j.status === 'running');
  if (running) return res.status(409).json({ error: 'A pull for this repository is already running', jobId: running.id });

  const op = fs.existsSync(path.join(dest, '.git')) ? 'pull' : 'clone';
  if (op === 'clone' && fs.existsSync(dest)) {
    return res.status(409).json({ error: 'A folder with this name exists but is not a git repository' });
  }
  const job = startJob({ url: url.trim(), repoName, op, dest, user: req.user, ip: req.ip });
  res.status(202).json({ jobId: job.id, repo: repoName, op });
}

// GET /api/github/repos — list what's on disk plus running jobs
router.get('/repos', (req, res) => {
  const repos = fs.readdirSync(config.REPOS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(config.REPOS_ROOT, e.name, '.git')))
    .map((e) => {
      const stat = fs.statSync(path.join(config.REPOS_ROOT, e.name));
      const job = [...jobs.values()].find((j) => j.repo === e.name && j.status === 'running');
      const hasIndex = fs.existsSync(path.join(config.REPOS_ROOT, e.name, 'index.html'));
      return { name: e.name, mtime: stat.mtimeMs, running: !!job, jobId: job ? job.id : null, hasIndex };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json({ repos });
});

// GET /api/github/jobs/:id/events — SSE stream of sanitized progress
router.get('/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  for (const entry of job.lines) send('line', entry);
  if (job.status !== 'running') {
    send('done', { status: job.status });
    return res.end();
  }

  const listener = (entry, status) => {
    if (entry) send('line', entry);
    if (status) {
      send('done', { status });
      cleanup();
      res.end();
    }
  };
  job.listeners.add(listener);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  function cleanup() {
    clearInterval(heartbeat);
    job.listeners.delete(listener);
  }
  req.on('close', cleanup);
});

module.exports = router;
// For tests.
module.exports.repoCapError = repoCapError;
module.exports.watchSize = watchSize;
module.exports.startJob = startJob;
