'use strict';
// End-to-end tests for SFTP sharing the web app's storage (job #24).
// Everything runs in a fresh temp folder: config is pointed there through the
// environment BEFORE any app module loads, so no real data is ever touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strongroom-test-'));
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
});

const { Client } = require('ssh2');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { db, createSession, getUserByUsername } = require('../src/db');
const { startSftpServer } = require('../src/sftp');

const USER = 'boss';
const PASS = 'test-password-123';
const HOME = path.join(config.STORAGE_ROOT, USER);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);

let server;
let port;
let web; // { base, headers }
let webServer;
let conn;
let sftp;

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => c.sftp((err, s) => (err ? reject(err) : resolve({ c, s }))));
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port, username: USER, password: PASS, hostVerifier: () => true });
  });
}

const p = (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
const put = (remote, data) => p(sftp.writeFile.bind(sftp))(remote, data);
const get = (remote) => p(sftp.readFile.bind(sftp))(remote);
const ls = (remote) => p(sftp.readdir.bind(sftp))(remote);
const mkdir = (remote) => p(sftp.mkdir.bind(sftp))(remote);
const rmdir = (remote) => p(sftp.rmdir.bind(sftp))(remote);
const rm = (remote) => p(sftp.unlink.bind(sftp))(remote);
const mv = (a, b) => p(sftp.rename.bind(sftp))(a, b);
const stat = (remote) => p(sftp.stat.bind(sftp))(remote);
const utimes = (remote, a, m) => p(sftp.utimes.bind(sftp))(remote, a, m);

const userId = () => getUserByUsername(USER).id;
const usedBytes = () => getUserByUsername(USER).used_bytes;
const rows = () => db.prepare('SELECT relpath, size FROM files WHERE user_id = ? ORDER BY id').all(userId()).map((r) => r.relpath);
const audits = (action) => db.prepare('SELECT detail FROM audit_logs WHERE action = ? ORDER BY id').all(action).map((r) => r.detail);
const tmpLeft = () => fs.readdirSync(config.TMP_DIR);

before(async () => {
  server = startSftpServer();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  port = server.address().port;
  ({ c: conn, s: sftp } = await connect());

  // The web file + user routes, signed in as the same user.
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/files', require('../src/routes/files'));
  app.use('/api/user', require('../src/routes/user'));
  webServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const sess = createSession(userId(), '127.0.0.1', 'test');
  const token = jwt.sign({ sid: sess.id }, config.JWT_SECRET, { algorithm: 'HS256' });
  web = {
    base: `http://127.0.0.1:${webServer.address().port}`,
    headers: { cookie: `${config.COOKIE_NAME}=${token}`, 'x-csrf-token': sess.csrf },
  };
});

after(() => {
  try { conn.end(); } catch { /* already gone */ }
  server.close();
  webServer.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('SFTP serves STORAGE_ROOT/<user>, the web app folder', async () => {
  await put('/hello.txt', 'hello from sftp');
  assert.equal(fs.readFileSync(path.join(HOME, 'hello.txt'), 'utf8'), 'hello from sftp');
  assert.equal(fs.existsSync(path.join(config.SFTP_ROOT, USER, 'hello.txt')), false);

  // A web upload is visible over SFTP...
  const form = new FormData();
  form.append('file', new Blob(['from the web']), 'web.txt');
  const res = await fetch(`${web.base}/api/files/upload?path=/`, { method: 'POST', headers: web.headers, body: form });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).results[0].ok, true);
  assert.equal((await get('/web.txt')).toString(), 'from the web');

  // ...and an SFTP upload is visible in the web listing.
  const list = await (await fetch(`${web.base}/api/files/list?path=/`, { headers: web.headers })).json();
  assert.ok(list.entries.some((e) => e.name === 'hello.txt'));
});

test('SFTP upload adds an uploads-list row, an audit entry and quota usage', async () => {
  const before = usedBytes();
  await put('/report.txt', 'x'.repeat(1000));
  assert.ok(rows().includes('/report.txt'));
  assert.ok(audits('sftp.upload').includes('/report.txt (1000 bytes)'));
  assert.equal(usedBytes(), before + 1000);
  assert.deepEqual(tmpLeft(), []);

  const overview = await (await fetch(`${web.base}/api/user/overview`, { headers: web.headers })).json();
  assert.ok(overview.recent.some((r) => r.path === '/report.txt'), 'shows under recent uploads');

  // Overwriting only counts the difference.
  await put('/report.txt', 'y'.repeat(400));
  assert.equal(usedBytes(), before + 400);
});

test('executables are blocked like on the web, with the reason sent to the client', async () => {
  await assert.rejects(put('/tool.exe', EXE), /Executable files are not allowed/);
  assert.equal(fs.existsSync(path.join(HOME, 'tool.exe')), false);
  assert.ok(audits('upload.blocked').some((d) => d.startsWith('/tool.exe: Executable')));
  assert.equal(rows().includes('/tool.exe'), false);
  assert.deepEqual(tmpLeft(), []);
});

test('a fake image is blocked, also when smuggled in as .partial and renamed', async () => {
  await assert.rejects(put('/photo.png', 'not really a png'), /Content does not match \.png/);
  assert.equal(fs.existsSync(path.join(HOME, 'photo.png')), false);

  await put('/photo.png.ab12.partial', 'not really a png');
  await assert.rejects(mv('/photo.png.ab12.partial', '/photo.png'), /Content does not match \.png/);
  assert.equal(fs.existsSync(path.join(HOME, 'photo.png')), false);
  await rm('/photo.png.ab12.partial');

  // A real PNG goes through.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await put('/real.png', png);
  assert.ok(fs.existsSync(path.join(HOME, 'real.png')));
});

test('quota is enforced and an over-quota upload leaves nothing behind', async () => {
  const id = userId();
  const oldQuota = getUserByUsername(USER).quota_bytes;
  db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(usedBytes() + 50, id);
  try {
    await assert.rejects(put('/big.bin', Buffer.alloc(500, 7)), /storage quota/);
    assert.equal(fs.existsSync(path.join(HOME, 'big.bin')), false);
    assert.deepEqual(tmpLeft(), []);
    await put('/small.txt', 'fits'); // still under the limit
  } finally {
    db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(oldQuota, id);
  }
});

test('file size cap (MAX_UPLOAD_BYTES) applies', async () => {
  const old = config.MAX_UPLOAD_BYTES;
  config.MAX_UPLOAD_BYTES = 100;
  try {
    await assert.rejects(put('/huge.txt', 'z'.repeat(300)), /MB limit/);
    assert.equal(fs.existsSync(path.join(HOME, 'huge.txt')), false);
  } finally {
    config.MAX_UPLOAD_BYTES = old;
  }
});

test('modification times are kept (SETSTAT and FSETSTAT)', async () => {
  const mtime = Math.floor(new Date('2024-03-15T10:20:30Z').getTime() / 1000);
  await put('/dated.txt', 'old file');
  await utimes('/dated.txt', mtime, mtime);
  assert.equal(Math.floor(fs.statSync(path.join(HOME, 'dated.txt')).mtimeMs / 1000), mtime);
  assert.equal((await stat('/dated.txt')).mtime, mtime);

  // Times set on the open handle before CLOSE survive the move into place.
  const handle = await p(sftp.open.bind(sftp))('/dated2.txt', 'w');
  await p(sftp.write.bind(sftp))(handle, Buffer.from('abc'), 0, 3, 0);
  await p(sftp.futimes.bind(sftp))(handle, mtime, mtime);
  await p(sftp.close.bind(sftp))(handle);
  assert.equal(Math.floor(fs.statSync(path.join(HOME, 'dated2.txt')).mtimeMs / 1000), mtime);
});

test('rename updates the uploads list and is audited; web naming rules apply', async () => {
  await mkdir('/docs');
  assert.ok(audits('sftp.mkdir').includes('/docs'));
  await put('/docs/a.txt', 'aaa');
  await mv('/docs/a.txt', '/docs/b.txt');
  assert.ok(rows().includes('/docs/b.txt'));
  assert.equal(rows().includes('/docs/a.txt'), false);
  assert.ok(audits('sftp.rename').includes('/docs/a.txt -> /docs/b.txt'));

  // Renaming a folder moves the rows under it.
  await mv('/docs', '/papers');
  assert.ok(rows().includes('/papers/b.txt'));
  assert.equal(rows().some((r) => r.startsWith('/docs/')), false);

  // Web naming rules apply to the new name; a folder is never replaced.
  await assert.rejects(mv('/papers/b.txt', '/papers/bad:name.txt'), /not allowed/);
  await mkdir('/papers/sub');
  await assert.rejects(mv('/papers/b.txt', '/papers/sub'), /already exists/);

  // Folder names with emoji (astral characters) keep their rows right.
  await mkdir('/\u{1F4C1}box');
  await put('/\u{1F4C1}box/in.txt', 'inside');
  await mv('/\u{1F4C1}box', '/\u{1F4E6}box');
  assert.ok(rows().includes('/\u{1F4E6}box/in.txt'));
  assert.equal(rows().some((r) => r.startsWith('/\u{1F4C1}')), false);
  await assert.rejects(put('/CON.txt', 'x'), /reserved/);
});

test('rclone partial upload: renaming over an existing file replaces it, quota stays right', async () => {
  await put('/song.txt', 'a'.repeat(100));
  const before = usedBytes();
  await put('/song.txt.x1y2.partial', 'b'.repeat(30));
  await mv('/song.txt.x1y2.partial', '/song.txt');
  assert.equal(fs.readFileSync(path.join(HOME, 'song.txt'), 'utf8'), 'b'.repeat(30));
  assert.equal(usedBytes(), before + 30 - 100);
  assert.equal(rows().filter((r) => r === '/song.txt').length, 1);
  assert.equal(rows().some((r) => r.endsWith('.partial')), false);
  assert.ok(audits('sftp.rename').includes('/song.txt.x1y2.partial -> /song.txt (replaced the old file)'));
});

test('overwriting keeps one uploads-list row per path', async () => {
  await put('/edited.txt', 'v1');
  await put('/edited.txt', 'v2');
  await put('/edited.txt', 'v3');
  assert.equal(rows().filter((r) => r === '/edited.txt').length, 1);
});

test('a refused new version keeps the old file, even if the client then deletes it', async () => {
  await put('/keep.txt', 'good version');
  await assert.rejects(put('/keep.txt', EXE), /Executable/);
  assert.equal(fs.readFileSync(path.join(HOME, 'keep.txt'), 'utf8'), 'good version');
  await assert.rejects(rm('/keep.txt'), /stored copy is kept/);
  assert.ok(fs.existsSync(path.join(HOME, 'keep.txt')));
});

test('a hostile READ offset does not crash the server', async () => {
  await put('/small-read.txt', 'abc');
  const handle = await p(sftp.open.bind(sftp))('/small-read.txt', 'r');
  const buf = Buffer.alloc(16);
  const n = await p(sftp.read.bind(sftp))(handle, buf, 0, 16, 2 ** 60).catch(() => 0); // EOF or an error, never a crash
  assert.ok(!n);
  await p(sftp.close.bind(sftp))(handle);
  assert.equal((await get('/small-read.txt')).toString(), 'abc'); // still serving
});

test('delete frees quota, removes uploads-list rows and is audited', async () => {
  await mkdir('/trashme');
  await put('/trashme/gone.txt', '12345');
  const before = usedBytes();
  await rm('/trashme/gone.txt');
  assert.equal(usedBytes(), before - 5);
  assert.equal(rows().includes('/trashme/gone.txt'), false);
  assert.ok(audits('sftp.delete').includes('/trashme/gone.txt (5 bytes)'));
  await rmdir('/trashme');
  assert.ok(audits('sftp.delete').includes('/trashme/ (folder)'));
  assert.equal(fs.existsSync(path.join(HOME, 'trashme')), false);
});

test('/repos is not reachable over SFTP in any form', async () => {
  fs.mkdirSync(path.join(config.REPOS_ROOT, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(config.REPOS_ROOT, 'proj', 'README.md'), 'repo file');

  await assert.rejects(ls('/repos'), (e) => e.code === 3); // PERMISSION_DENIED
  await assert.rejects(get('/repos/proj/README.md'), (e) => e.code === 3);
  await assert.rejects(put('/repos/proj/evil.txt', 'x'), (e) => e.code === 3);
  await assert.rejects(put('/Repos/evil.txt', 'x'), (e) => e.code === 3);
  await assert.rejects(mkdir('/repos'), (e) => e.code === 3);
  await assert.rejects(mkdir('/REPOS'), (e) => e.code === 3);
  await assert.rejects(mv('/hello.txt', '/repos'), (e) => e.code === 3);
  await assert.rejects(mv('/hello.txt', '/repos/hello.txt'), (e) => e.code === 3);
  await assert.rejects(mv('/repos/proj', '/stolen'), (e) => e.code === 3);
  await assert.rejects(utimes('/repos/proj/README.md', 1, 1), (e) => e.code === 3);
  await assert.rejects(rm('/repos/proj/README.md'), (e) => e.code === 3);
  await assert.rejects(stat('/papers/../repos'), (e) => e.code === 3);
  assert.equal(fs.readFileSync(path.join(config.REPOS_ROOT, 'proj', 'README.md'), 'utf8'), 'repo file');
  assert.equal(fs.existsSync(path.join(config.REPOS_ROOT, 'proj', 'evil.txt')), false);

  // A stray "repos" folder in storage (made outside the app) is never listed.
  fs.mkdirSync(path.join(HOME, 'repos'), { recursive: true });
  const names = (await ls('/')).map((e) => e.filename);
  assert.equal(names.includes('repos'), false);
  assert.ok(names.includes('hello.txt'));
});

test('paths cannot climb out of the user folder', async () => {
  fs.writeFileSync(path.join(config.STORAGE_ROOT, 'secret.txt'), 'other user area');
  await assert.rejects(get('/../secret.txt'), (e) => e.code === 2); // resolves to /secret.txt in the jail: no such file
  await assert.rejects(get('../../data/strongroom.db'), (e) => e.code === 2);
  await assert.rejects(get('\\..\\..\\secret.txt'), (e) => e.code === 2);
  const real = await p(sftp.realpath.bind(sftp))('/../../..');
  assert.equal(real, '/');
});

test('big folders are listed completely (paged READDIR)', async () => {
  const dir = path.join(HOME, 'many');
  fs.mkdirSync(dir);
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(dir, `file-with-a-longish-name-${i}.txt`), '');
  const names = (await ls('/many')).map((e) => e.filename);
  assert.equal(names.length, 3000);
  assert.equal(new Set(names).size, 3000);
});

test('an interrupted upload never lands in storage and leaves no temp file', async () => {
  const { c, s } = await connect();
  const handle = await new Promise((r, j) => s.open('/half.txt', 'w', (e, h) => (e ? j(e) : r(h))));
  await new Promise((r, j) => s.write(handle, Buffer.from('half'), 0, 4, 0, (e) => (e ? j(e) : r())));
  assert.equal(tmpLeft().length, 1);
  c.end();
  for (let i = 0; i < 50 && tmpLeft().length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(tmpLeft(), []);
  assert.equal(fs.existsSync(path.join(HOME, 'half.txt')), false);
});
