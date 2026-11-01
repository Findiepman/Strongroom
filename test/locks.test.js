'use strict';
// Locked folders: a folder with its own password, on top of the sign-in.
// Two web sessions of the same user: "a" locks (and so has it open), "b" is
// another browser that hasn't typed the folder password. Plus SFTP, which
// never sees locked folders. Everything runs in a fresh temp folder.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strongroom-locks-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: path.join(TMP, 'data'),
  STORAGE_ROOT: path.join(TMP, 'storage'),
  REPOS_ROOT: path.join(TMP, 'repos'),
  TMP_DIR: path.join(TMP, 'tmp'),
  SFTP_ROOT: path.join(TMP, 'old-sftp'),
  SFTP_ENABLED: 'true',
  SFTP_PORT: '0',
  SFTP_HOST: '127.0.0.1',
  ADMIN_USERNAME: 'boss',
  ADMIN_PASSWORD: 'test-password-123',
  DEFAULT_QUOTA_BYTES: String(50 * 1024 * 1024),
  JWT_SECRET: 'test-secret-not-real',
  BCRYPT_COST: '4',
});

const { Client } = require('ssh2');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { db, createSession, deleteSession, getUserByUsername } = require('../src/db');
const { startSftpServer } = require('../src/sftp');

const USER = 'boss';
const HOME = path.join(config.STORAGE_ROOT, USER);
const PW = 'folder-pass-1';

let webServer;
let base;
let sftpServer;
let conn;
let sftp;

function session() {
  const s = createSession(getUserByUsername(USER).id, '127.0.0.1', 'test');
  const token = jwt.sign({ sid: s.id }, config.JWT_SECRET, { algorithm: 'HS256' });
  return { id: s.id, headers: { cookie: `${config.COOKIE_NAME}=${token}`, 'x-csrf-token': s.csrf } };
}

async function call(who, method, url, body) {
  const opts = { method, headers: { ...who.headers } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a file */ }
  return { status: res.status, json, text };
}
const get = (who, url) => call(who, 'GET', url);
const post = (who, url, body) => call(who, 'POST', url, body);
const enc = encodeURIComponent;

async function upload(who, dir, name, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  const res = await fetch(`${base}/api/files/upload?path=${enc(dir)}`, { method: 'POST', headers: who.headers, body: form });
  return { status: res.status, json: await res.json() };
}

const p = (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
const sls = (remote) => p(sftp.readdir.bind(sftp))(remote).then((l) => l.map((e) => e.filename).sort());
const sget = (remote) => p(sftp.readFile.bind(sftp))(remote);
const sstat = (remote) => p(sftp.stat.bind(sftp))(remote);
const smv = (a, b) => p(sftp.rename.bind(sftp))(a, b);

let a; // locked it, has it open
let b; // a second browser

before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/files', require('../src/routes/files'));
  app.use('/api/user', require('../src/routes/user'));
  webServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${webServer.address().port}`;

  sftpServer = startSftpServer();
  await new Promise((r) => (sftpServer.listening ? r() : sftpServer.once('listening', r)));
  await new Promise((resolve, reject) => {
    conn = new Client();
    conn.on('ready', () => conn.sftp((err, s) => { if (err) return reject(err); sftp = s; resolve(); }));
    conn.on('error', reject);
    conn.connect({ host: '127.0.0.1', port: sftpServer.address().port, username: USER, password: 'test-password-123', hostVerifier: () => true });
  });

  a = session();
  b = session();
  fs.mkdirSync(path.join(HOME, 'code', 'secret', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'code', 'secret', 'plan.txt'), 'the plan');
  fs.writeFileSync(path.join(HOME, 'code', 'secret', 'deep', 'key.txt'), 'deep secret');
  fs.writeFileSync(path.join(HOME, 'code', 'open.txt'), 'not secret');
});

after(() => {
  try { sftp.end(); conn.end(); } catch { /* gone */ }
  sftpServer.close();
  webServer.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('locking needs a real folder and a password of 4+ characters', async () => {
  assert.equal((await post(a, '/api/files/lock', { path: '/code/secret', password: 'abc' })).status, 400);
  assert.equal((await post(a, '/api/files/lock', { path: '/nope', password: PW })).status, 400);
  assert.equal((await post(a, '/api/files/lock', { path: '/', password: PW })).status, 400);
  assert.equal((await post(a, '/api/files/lock', { path: '/repos', password: PW })).status, 400);
  const r = await post(a, '/api/files/lock', { path: '/code/secret', password: PW });
  assert.equal(r.status, 200, r.text);
  assert.equal((await post(a, '/api/files/lock', { path: '/code/secret', password: PW })).status, 409, 'already locked');
  const row = db.prepare('SELECT password_hash FROM folder_locks WHERE relpath = ?').get('/code/secret');
  assert.ok(row && row.password_hash.startsWith('$2') && !row.password_hash.includes(PW), 'stored as a bcrypt hash');
});

test('the parent listing marks it; the session that locked it has it open', async () => {
  const la = await get(a, '/api/files/list?path=/code');
  assert.deepEqual(la.json.entries.find((e) => e.name === 'secret').lock, { open: true });
  assert.equal(la.json.entries.find((e) => e.name === 'open.txt').lock, undefined);
  const inside = await get(a, '/api/files/list?path=/code/secret');
  assert.equal(inside.status, 200);
  assert.deepEqual(inside.json.lockedBy, ['/code/secret']);

  const lb = await get(b, '/api/files/list?path=/code');
  assert.deepEqual(lb.json.entries.find((e) => e.name === 'secret').lock, { open: false });
});

test('another session gets 423 for everything inside, and nothing leaks', async () => {
  const L = { locked: '/code/secret' };
  for (const url of [
    '/api/files/list?path=/code/secret',
    '/api/files/list?path=/code/secret/deep',
    '/api/files/download?path=/code/secret/plan.txt',
    '/api/files/download?path=/code/secret/plan.txt&check=1',
    '/api/files/preview?path=/code/secret/plan.txt',
    '/api/files/preview?path=/code/secret/deep/key.txt&thumb=1',
    '/api/files/download-zip?path=/code/secret',
  ]) {
    const r = await get(b, url);
    assert.equal(r.status, 423, url);
    assert.equal(r.json.locked, L.locked, url);
    assert.ok(!r.text.includes('the plan') && !r.text.includes('deep secret'), url);
  }
  // A zip of a folder that holds it is refused too (it would contain it).
  for (const zip of ['/api/files/download-zip?path=/code', '/api/files/download-zip?path=/']) {
    const r = await get(b, zip);
    assert.equal(r.status, 423, zip);
    assert.ok(!r.text.includes('the plan'));
  }
  // Uploads and new folders inside are refused.
  assert.equal((await upload(b, '/code/secret', 'x.txt', 'x')).status, 423);
  assert.equal((await post(b, '/api/files/mkdir', { path: '/code/secret', name: 'new' })).status, 423);
  assert.equal(fs.existsSync(path.join(HOME, 'code', 'secret', 'x.txt')), false);
  assert.equal(fs.existsSync(path.join(HOME, 'code', 'secret', 'new')), false);
  // Delete: of it, of something in it, of a folder that holds it.
  const del = await post(b, '/api/files/delete', { paths: ['/code/secret/plan.txt', '/code/secret', '/code'] });
  assert.ok(del.json.results.every((r) => !r.ok && r.locked === '/code/secret'), JSON.stringify(del.json));
  assert.ok(fs.existsSync(path.join(HOME, 'code', 'secret', 'plan.txt')));
  // Rename of anything inside: 423; of it or a folder that holds it: refused.
  assert.equal((await post(b, '/api/files/rename', { path: '/code/secret/plan.txt', newName: 'p.txt' })).status, 423);
  assert.equal((await post(a, '/api/files/rename', { path: '/code/secret', newName: 'other' })).status, 409, 'even when open');
  assert.equal((await post(a, '/api/files/rename', { path: '/code', newName: 'code2' })).status, 409);
  assert.ok(fs.existsSync(path.join(HOME, 'code', 'secret')));
  // Path tricks resolve to the same folder.
  for (const trick of ['/code/./secret', '/code/x/../secret/plan.txt', '\\code\\secret', 'code//secret']) {
    const r = await get(b, '/api/files/list?path=' + enc(trick));
    assert.ok(r.status === 423 || r.status === 400, `${trick}: ${r.status}`);
  }
});

test('search finds the locked folder by name but nothing inside it', async () => {
  assert.equal((await get(b, '/api/files/search?q=plan')).json.results.length, 0);
  assert.equal((await get(b, '/api/files/search?q=key')).json.results.length, 0);
  const s = (await get(b, '/api/files/search?q=secret')).json.results;
  assert.deepEqual(s.map((r) => r.path), ['/code/secret']);
  assert.deepEqual(s[0].lock, { open: false });
  assert.equal((await get(a, '/api/files/search?q=plan')).json.results.length, 1, 'the open session finds it');
});

test('recent uploads and activity hide what is inside a closed locked folder', async () => {
  const up = await upload(a, '/code/secret', 'fresh.txt', 'uploaded while open');
  assert.equal(up.json.results[0].ok, true);
  assert.equal((await get(a, '/api/files/download?path=/code/secret/fresh.txt')).text, 'uploaded while open');
  const ova = (await get(a, '/api/user/overview')).json;
  assert.ok(ova.recent.some((r) => r.path === '/code/secret/fresh.txt'));
  const ovb = (await get(b, '/api/user/overview')).json;
  assert.ok(!ovb.recent.some((r) => r.path.startsWith('/code/secret')));
  assert.ok(!ovb.activity.some((r) => String(r.detail).includes('fresh.txt')), 'no file names in the feed');
  assert.ok(ovb.activity.some((r) => r.action === 'folder.lock'), 'lock events stay');
});

test('a wrong password is refused and logged; the right one opens it for that session only', async () => {
  const bad = await post(b, '/api/files/unlock', { path: '/code/secret', password: 'wrong-one' });
  assert.equal(bad.status, 403);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'folder.unlock.fail' AND detail = '/code/secret'").get());
  assert.equal((await post(b, '/api/files/unlock', { path: '/code/open.txt', password: PW })).status, 404, 'not a lock');
  const ok = await post(b, '/api/files/unlock', { path: '/code/secret', password: PW });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.minutes, 15);
  assert.equal((await get(b, '/api/files/list?path=/code/secret/deep')).status, 200);
  assert.equal((await get(b, '/api/files/download?path=/code/secret/deep/key.txt')).text, 'deep secret');
  assert.equal((await get(b, '/api/files/download-zip?path=/code&check=1')).status, 200);
  const c = session();
  assert.equal((await get(c, '/api/files/list?path=/code/secret')).status, 423, 'a third session is still locked out');
});

test('Lock now, the 15 minute timeout and signing out all close it again', async () => {
  assert.equal((await post(b, '/api/files/relock', { path: '/code/secret' })).status, 200);
  assert.equal((await get(b, '/api/files/list?path=/code/secret')).status, 423);

  await post(b, '/api/files/unlock', { path: '/code/secret', password: PW });
  // Each use pushes the 15 minutes back.
  const exp = () => db.prepare('SELECT expires_at FROM folder_unlocks WHERE session_id = ?').get(b.id).expires_at;
  db.prepare('UPDATE folder_unlocks SET expires_at = ? WHERE session_id = ?').run(Date.now() + 1000, b.id);
  await get(b, '/api/files/list?path=/code/secret');
  assert.ok(exp() > Date.now() + 14 * 60 * 1000, 'used: open for another 15 minutes');
  // 15 minutes without using it.
  db.prepare('UPDATE folder_unlocks SET expires_at = ? WHERE session_id = ?').run(Date.now() - 1, b.id);
  assert.equal((await get(b, '/api/files/list?path=/code/secret')).status, 423);

  await post(b, '/api/files/unlock', { path: '/code/secret', password: PW });
  deleteSession(b.id); // sign-out
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM folder_unlocks WHERE session_id = ?').get(b.id).n, 0);
  b = session();
  assert.equal((await get(b, '/api/files/list?path=/code/secret')).status, 423);
});

test('nested locks: the outer one has to be open first', async () => {
  assert.equal((await post(a, '/api/files/lock', { path: '/code/secret/deep', password: 'inner-pass' })).status, 200);
  assert.equal((await post(b, '/api/files/unlock', { path: '/code/secret/deep', password: 'inner-pass' })).status, 423, 'outer closed');
  await post(b, '/api/files/unlock', { path: '/code/secret', password: PW });
  const r = await get(b, '/api/files/list?path=/code/secret/deep');
  assert.equal(r.status, 423);
  assert.equal(r.json.locked, '/code/secret/deep');
  assert.equal((await post(b, '/api/files/unlock', { path: '/code/secret/deep', password: 'inner-pass' })).status, 200);
  assert.equal((await get(b, '/api/files/list?path=/code/secret/deep')).status, 200);
  assert.equal((await post(a, '/api/files/unlock-remove', { path: '/code/secret/deep', password: 'inner-pass' })).status, 200);
});

test('SFTP never shows or opens a locked folder', async () => {
  assert.deepEqual(await sls('/code'), ['open.txt'], 'not listed');
  await assert.rejects(sls('/code/secret'));
  await assert.rejects(sget('/code/secret/plan.txt'));
  await assert.rejects(sstat('/code/secret'));
  await assert.rejects(sget('/code/./secret/../secret/plan.txt'));
  await assert.rejects(smv('/code/secret', '/moved'));
  await assert.rejects(smv('/code', '/code-renamed'), 'holds a locked folder');
  await assert.rejects(smv('/code/open.txt', '/code/secret/open.txt'), 'nothing goes in');
  assert.ok(fs.existsSync(path.join(HOME, 'code', 'secret', 'plan.txt')));
  assert.ok(fs.existsSync(path.join(HOME, 'code', 'open.txt')));
  assert.equal((await sget('/code/open.txt')).toString(), 'not secret', 'the rest still works');
});

test('deleting a locked folder keeps the lock, so a backup that puts it back is locked', async () => {
  await post(b, '/api/files/relock', { path: '/code/secret' }); // b opened it in the nested-locks test
  const del = await post(a, '/api/files/delete', { paths: ['/code/secret'] });
  assert.equal(del.json.results[0].ok, true, JSON.stringify(del.json));
  assert.equal(fs.existsSync(path.join(HOME, 'code', 'secret')), false);
  fs.mkdirSync(path.join(HOME, 'code', 'secret'));
  fs.writeFileSync(path.join(HOME, 'code', 'secret', 'plan.txt'), 'restored by the backup');
  assert.equal((await get(b, '/api/files/list?path=/code/secret')).status, 423);
  assert.deepEqual(await sls('/code'), ['open.txt']);
});

test('removing the lock needs its password; then the sign-in alone opens it', async () => {
  assert.equal((await post(a, '/api/files/unlock-remove', { path: '/code/secret', password: 'nope-nope' })).status, 403);
  assert.equal((await get(b, '/api/files/list?path=/code/secret')).status, 423);
  assert.equal((await post(a, '/api/files/unlock-remove', { path: '/code/secret', password: PW })).status, 200);
  assert.equal((await get(b, '/api/files/list?path=/code/secret')).status, 200);
  assert.deepEqual(await sls('/code'), ['open.txt', 'secret']);
});

test('10 wrong folder passwords in 15 minutes stop further tries', async () => {
  await post(a, '/api/files/lock', { path: '/code/secret', password: PW });
  const c = session();
  db.prepare("DELETE FROM audit_logs WHERE action = 'folder.unlock.fail'").run();
  for (let i = 0; i < 10; i++) {
    assert.equal((await post(c, '/api/files/unlock', { path: '/code/secret', password: 'guess-' + i })).status, 403);
  }
  const r = await post(c, '/api/files/unlock', { path: '/code/secret', password: PW });
  assert.equal(r.status, 429, 'even the right one waits');
  assert.equal((await get(c, '/api/files/list?path=/code/secret')).status, 423);
});
