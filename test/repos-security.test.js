'use strict';
// Symlinks in pulled repos (and in user storage) must never lead outside
// their root, /live previews run sandboxed, and repos have size caps.
// Everything runs in a fresh temp folder; config is pointed there through the
// environment BEFORE any app module loads.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strongroom-repos-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: path.join(TMP, 'data'),
  STORAGE_ROOT: path.join(TMP, 'storage'),
  REPOS_ROOT: path.join(TMP, 'repos'),
  TMP_DIR: path.join(TMP, 'tmp'),
  SFTP_ENABLED: 'false',
  ADMIN_USERNAME: 'boss',
  ADMIN_PASSWORD: 'test-password-123',
  DEFAULT_QUOTA_BYTES: String(50 * 1024 * 1024),
  JWT_SECRET: 'test-secret-not-real',
  REPO_MAX_BYTES: String(300 * 1024),
  REPOS_MAX_TOTAL_BYTES: String(10 * 1024 * 1024),
});

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { db, createSession, getUserByUsername } = require('../src/db');
const { isRealInside } = require('../src/util/paths');
const github = require('../src/routes/github');
const live = require('../src/routes/live');

const OUTSIDE = path.join(TMP, 'outside');     // stands in for /home/fin
const SITE = path.join(config.REPOS_ROOT, 'site');
const HOME = path.join(config.STORAGE_ROOT, 'boss');
let server;
let base;
let headers;
let cookie;

// A symlink to a folder: a junction on Windows (no admin rights needed), a
// plain symlink on Linux (the type argument is ignored there).
const linkDir = (target, at) => fs.symlinkSync(target, at, 'junction');
// A symlink to a file needs extra rights on Windows: null when not allowed.
function linkFile(target, at) {
  try { fs.symlinkSync(target, at, 'file'); return true; } catch { return false; }
}

const get = (url, extra = {}) => fetch(`${base}${url}`, { headers, redirect: 'manual', ...extra });
const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/files', require('../src/routes/files'));
  app.use('/live', live);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const s = createSession(getUserByUsername('boss').id, '127.0.0.1', 'test');
  cookie = `${config.COOKIE_NAME}=${jwt.sign({ sid: s.id }, config.JWT_SECRET, { algorithm: 'HS256' })}`;
  headers = { cookie, 'x-csrf-token': s.csrf };

  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'TOP-SECRET');
  fs.writeFileSync(path.join(OUTSIDE, 'index.html'), '<p>outside</p>');

  fs.mkdirSync(path.join(SITE, '.git'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'index.html'), '<script src="app.js"></script>');
  fs.writeFileSync(path.join(SITE, 'app.js'), 'console.log(1)');
  linkDir(OUTSIDE, path.join(SITE, 'outdir'));
  fs.mkdirSync(path.join(config.REPOS_ROOT, 'other', '.git'), { recursive: true });
  fs.writeFileSync(path.join(config.REPOS_ROOT, 'other', 'index.html'), 'other');

  fs.mkdirSync(path.join(HOME, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'docs', 'a.txt'), 'hello');
  linkDir(OUTSIDE, path.join(HOME, 'docs', 'escape'));
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- real-path containment ----

test('isRealInside follows links and judges missing paths by their parent', () => {
  assert.equal(isRealInside(config.REPOS_ROOT, path.join(SITE, 'app.js')), true);
  assert.equal(isRealInside(config.REPOS_ROOT, path.join(SITE, 'new', 'deeper')), true);
  assert.equal(isRealInside(config.REPOS_ROOT, path.join(SITE, 'outdir')), false);
  assert.equal(isRealInside(config.REPOS_ROOT, path.join(SITE, 'outdir', 'secret.txt')), false);
  assert.equal(isRealInside(config.REPOS_ROOT, path.join(SITE, 'outdir', 'not-there')), false);
});

test('a symlinked folder in a repo is refused by list, download, preview and zip', async () => {
  for (const url of [
    '/api/files/list?path=/repos/site/outdir',
    '/api/files/download?path=/repos/site/outdir/secret.txt',
    '/api/files/preview?path=/repos/site/outdir/secret.txt',
    '/api/files/download-zip?path=/repos/site/outdir',
  ]) {
    const r = await get(url);
    const body = await r.text();
    assert.equal(r.status, 403, url);
    assert.ok(!body.includes('TOP-SECRET'), url);
  }
  // The link isn't listed, and the folder holding it still works.
  const list = await (await get('/api/files/list?path=/repos/site')).json();
  assert.deepEqual(list.entries.map((e) => e.name).sort(), ['app.js', 'index.html']);
});

test('a symlinked file in a repo is refused', async (t) => {
  if (!linkFile(path.join(OUTSIDE, 'secret.txt'), path.join(SITE, 'leak'))) return t.skip('no rights to create file symlinks here');
  for (const url of ['/api/files/download?path=/repos/site/leak', '/api/files/preview?path=/repos/site/leak']) {
    const r = await get(url);
    assert.equal(r.status, 403, url);
    assert.ok(!(await r.text()).includes('TOP-SECRET'));
  }
  const r = await get('/live/site/leak');
  const r2 = await fetch(base + r.headers.get('location'), { redirect: 'manual' });
  assert.equal(r2.status, 404);
  assert.ok(!(await r2.text()).includes('TOP-SECRET'));
  fs.unlinkSync(path.join(SITE, 'leak'));
});

test('a repo zip leaves symlinks out and still has its files', async () => {
  const r = await get('/api/files/download-zip?path=/repos/site');
  assert.equal(r.status, 200);
  const zip = Buffer.from(await r.arrayBuffer()).toString('latin1');
  assert.ok(zip.includes('site/index.html'));
  assert.ok(zip.includes('site/app.js'));
  assert.ok(!zip.includes('outdir'), 'link entry left out');
  assert.ok(!zip.includes('secret.txt'));
});

test('user storage: a link out is refused, and deleting the link removes only the link', async () => {
  let r = await get('/api/files/list?path=/docs/escape');
  assert.equal(r.status, 403);
  r = await get('/api/files/download?path=/docs/escape/secret.txt');
  assert.equal(r.status, 403);
  r = await post('/api/files/mkdir', { path: '/docs/escape', name: 'planted' });
  assert.equal(r.status, 403);
  assert.equal(fs.existsSync(path.join(OUTSIDE, 'planted')), false);

  const form = new FormData();
  form.append('file', new Blob(['planted']), 'planted.txt');
  r = await fetch(`${base}/api/files/upload?path=${encodeURIComponent('/docs/escape')}`, { method: 'POST', headers, body: form });
  assert.equal(r.status, 403);
  assert.equal(fs.existsSync(path.join(OUTSIDE, 'planted.txt')), false);

  // The zip of the folder holding the link has the real file, not the link.
  r = await get('/api/files/download-zip?path=/docs');
  const zip = Buffer.from(await r.arrayBuffer()).toString('latin1');
  assert.ok(zip.includes('docs/a.txt'));
  assert.ok(!zip.includes('escape'));

  const del = await (await post('/api/files/delete', { paths: ['/docs/escape'] })).json();
  assert.equal(del.results[0].ok, true, JSON.stringify(del));
  assert.equal(fs.existsSync(path.join(HOME, 'docs', 'escape')), false);
  assert.equal(fs.readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8'), 'TOP-SECRET');
});

// ---- /live ----

async function openLive(repoPath) {
  const r = await get(`/live/${repoPath}`);
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/live\/_\/[A-Za-z0-9_-]{32}\//);
  return loc;
}

test('/live redirects a signed-in visit to a token URL that works without the cookie', async () => {
  const loc = await openLive('site/');
  const r = await fetch(base + loc, { redirect: 'manual' }); // like the sandboxed page: no cookie
  assert.equal(r.status, 200);
  assert.match(await r.text(), /app\.js/);
  const js = await fetch(base + loc + 'app.js');
  assert.equal(js.status, 200);
  // The same repo reuses its token.
  assert.equal(await openLive('site/'), loc);
});

test('/live responses are sandboxed to an opaque origin', async () => {
  const loc = await openLive('site/');
  const r = await fetch(base + loc);
  const csp = r.headers.get('content-security-policy');
  assert.equal(csp, 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads');
  assert.ok(!csp.includes('allow-same-origin'));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
});

test('/live refuses symlinks out of REPOS_ROOT, other repos and bad tokens', async () => {
  const loc = await openLive('site/');
  const token = loc.split('/')[3];
  for (const url of [
    loc + 'outdir/secret.txt',
    loc + 'outdir/',
    `/live/_/${token}/other/index.html`,
    `/live/_/${token}/site/..%2fother/index.html`,
  ]) {
    const r = await fetch(base + url, { redirect: 'manual' });
    assert.equal(r.status, 404, url);
    assert.ok(!(await r.text()).includes('TOP-SECRET'), url);
  }
  // Without the cookie: no token, back to the sign-in page.
  let r = await fetch(`${base}/live/site/`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  r = await fetch(`${base}/live/_/${'x'.repeat(32)}/site/`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/');
  // A repo folder linked from REPOS_ROOT itself is refused too.
  linkDir(OUTSIDE, path.join(config.REPOS_ROOT, 'evil'));
  fs.mkdirSync(path.join(OUTSIDE, '.git'));
  r = await get('/live/evil/secret.txt');
  if (r.status === 302) r = await fetch(base + r.headers.get('location'), { redirect: 'manual' });
  assert.equal(r.status, 404);
  assert.ok(!(await r.text()).includes('TOP-SECRET'));
  fs.rmSync(path.join(OUTSIDE, '.git'), { recursive: true });
  fs.unlinkSync(path.join(config.REPOS_ROOT, 'evil'));
});

test('/live tokens die with the sign-in session', async () => {
  const s = createSession(getUserByUsername('boss').id, '127.0.0.1', 'test');
  const c = `${config.COOKIE_NAME}=${jwt.sign({ sid: s.id }, config.JWT_SECRET, { algorithm: 'HS256' })}`;
  const r = await fetch(`${base}/live/site/`, { headers: { cookie: c }, redirect: 'manual' });
  const loc = r.headers.get('location');
  assert.equal((await fetch(base + loc)).status, 200);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  const after = await fetch(base + loc, { redirect: 'manual' });
  assert.equal(after.status, 302);
  assert.equal(after.headers.get('location'), '/');
});

// ---- git: symlinks off, size caps ----

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString().trim();

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// A local source repo (no network): one commit with a symlink to an absolute
// path outside, added straight to the index so creating it needs no rights.
function makeSourceRepo(name, { bigBytes = 0 } = {}) {
  const src = path.join(TMP, 'src', name);
  fs.mkdirSync(src, { recursive: true });
  git(src, 'init', '-q');
  fs.writeFileSync(path.join(src, 'index.html'), 'hi');
  if (bigBytes) fs.writeFileSync(path.join(src, 'big.bin'), require('crypto').randomBytes(bigBytes));
  git(src, 'add', '.');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: src, input: path.join(OUTSIDE, 'secret.txt') }).toString().trim();
  git(src, 'update-index', '--add', '--cacheinfo', `120000,${blob},leak`);
  git(src, 'commit', '-q', '-m', 'init');
  return src;
}

function runJob(opts) {
  const user = getUserByUsername('boss');
  const job = github.startJob({ user, ip: '127.0.0.1', ...opts });
  return new Promise((resolve) => {
    job.listeners.add((entry, status) => { if (status) resolve(job); });
  });
}

test('clones and pulls write repo symlinks as plain files', async (t) => {
  if (!hasGit()) return t.skip('git not installed');
  const src = makeSourceRepo('linky');
  const dest = path.join(config.REPOS_ROOT, 'linky');
  const job = await runJob({ url: src, repoName: 'linky', op: 'clone', dest });
  assert.equal(job.status, 'done', job.lines.map((l) => l.text).join('\n'));
  const st = fs.lstatSync(path.join(dest, 'leak'));
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isFile(), true);
  assert.equal(git(dest, 'config', '--local', 'core.symlinks'), 'false');

  // A pull brings a new link in as a plain file too.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: src, input: OUTSIDE }).toString().trim();
  git(src, 'update-index', '--add', '--cacheinfo', `120000,${blob},leak2`);
  git(src, 'commit', '-q', '-m', 'more');
  const pull = await runJob({ url: src, repoName: 'linky', op: 'pull', dest });
  assert.equal(pull.status, 'done', pull.lines.map((l) => l.text).join('\n'));
  assert.equal(fs.lstatSync(path.join(dest, 'leak2')).isSymbolicLink(), false);
  fs.rmSync(dest, { recursive: true, force: true });
});

test('a clone bigger than REPO_MAX_BYTES fails and leaves nothing behind', async (t) => {
  if (!hasGit()) return t.skip('git not installed');
  const src = makeSourceRepo('huge', { bigBytes: 600 * 1024 }); // random, so it doesn't compress
  const dest = path.join(config.REPOS_ROOT, 'huge');
  const job = await runJob({ url: src, repoName: 'huge', op: 'clone', dest });
  assert.equal(job.status, 'failed');
  assert.match(job.lines.map((l) => l.text).join('\n'), /bigger than the 300 KB limit/);
  assert.equal(fs.existsSync(dest), false);
});

test('watchSize stops a growing folder once it passes the limit', async () => {
  const dir = path.join(TMP, 'growing');
  fs.mkdirSync(dir);
  let hit = null;
  const stop = github.watchSize(dir, 1000, (bytes) => { hit = bytes; }, 20);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hit, null, 'under the limit: keeps watching');
  fs.writeFileSync(path.join(dir, 'a'), Buffer.alloc(1500));
  for (let i = 0; i < 50 && hit === null; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(hit, 1500);
  stop();

  // A stopped watcher never fires.
  let fired = false;
  const stop2 = github.watchSize(dir, 10, () => { fired = true; }, 20);
  stop2();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, false);
});

test('repoCapError refuses at the total cap and counts running jobs at their worst case', () => {
  const caps = { maxRepoBytes: 1000, maxTotalBytes: 10000 };
  assert.equal(github.repoCapError({ ...caps, totalBytes: 0, runningJobs: 0 }), null);
  assert.equal(github.repoCapError({ ...caps, totalBytes: 9999, runningJobs: 0 }), null);
  assert.match(github.repoCapError({ ...caps, totalBytes: 10000, runningJobs: 0 }), /storage is full/);
  assert.match(github.repoCapError({ ...caps, totalBytes: 20000, runningJobs: 0 }), /storage is full/);
  assert.equal(github.repoCapError({ ...caps, totalBytes: 5000, runningJobs: 4 }), null);
  assert.match(github.repoCapError({ ...caps, totalBytes: 5000, runningJobs: 5 }), /nearly full/);
});

test('POST /api/github/repos refuses when REPOS_ROOT is over the total cap', async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/github', github);
  const s2 = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const filler = path.join(config.REPOS_ROOT, 'filler');
  fs.mkdirSync(filler);
  fs.writeFileSync(path.join(filler, 'blob'), Buffer.alloc(config.REPOS_MAX_TOTAL_BYTES));
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/github/repos`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/someone/newrepo' }),
    });
    assert.equal(r.status, 507);
    assert.match((await r.json()).error, /storage is full/);
    assert.equal(fs.existsSync(path.join(config.REPOS_ROOT, 'newrepo')), false);
  } finally {
    s2.close();
    fs.rmSync(filler, { recursive: true, force: true });
  }
});
