'use strict';
// Web uploads reserve quota as their bytes arrive (src/util/quota.js), so
// parallel uploads can't together pass the quota, and every way an upload
// ends gives its reservation back.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strongroom-quota-'));
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
});

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { db, createSession, getUserByUsername } = require('../src/db');
const quota = require('../src/util/quota');

const HOME = path.join(config.STORAGE_ROOT, 'boss');
const QUOTA = 1024 * 1024;
let server;
let base;
let headers;

const user = () => getUserByUsername('boss');
const tmpLeft = () => fs.readdirSync(config.TMP_DIR);
const setUsage = (used) => db.prepare('UPDATE users SET used_bytes = ?, quota_bytes = ? WHERE id = ?').run(used, QUOTA, user().id);

function upload(name, bytes, query = '') {
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(bytes, 'a')]), name);
  return fetch(`${base}/api/files/upload?path=/${query}`, { method: 'POST', headers, body: form }).then((r) => r.json());
}

// Settles when the server holds no reservations and no temp files any more.
async function settled() {
  for (let i = 0; i < 100; i++) {
    if (quota.pending(user().id) === 0 && tmpLeft().length === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/files', require('../src/routes/files'));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const s = createSession(user().id, '127.0.0.1', 'test');
  headers = { cookie: `${config.COOKIE_NAME}=${jwt.sign({ sid: s.id }, config.JWT_SECRET, { algorithm: 'HS256' })}`, 'x-csrf-token': s.csrf };
  fs.mkdirSync(HOME, { recursive: true });
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('two parallel uploads that together pass the quota: at most one lands', async () => {
  setUsage(0);
  const size = 700 * 1024;
  const [a, b] = await Promise.all([upload('a.txt', size), upload('b.txt', size)]);
  const results = [...a.results, ...b.results];
  const ok = results.filter((r) => r.ok);
  assert.ok(ok.length <= 1, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.equal(r.error, 'Upload exceeds your storage quota');
  await settled();
  assert.equal(quota.pending(user().id), 0, 'every reservation given back');
  assert.deepEqual(tmpLeft(), []);
  assert.ok(user().used_bytes <= QUOTA);
  assert.equal(user().used_bytes, ok.length * size);
  for (const n of ['a.txt', 'b.txt']) fs.rmSync(path.join(HOME, n), { force: true });
});

test('many parallel small uploads never pass the quota', async () => {
  setUsage(0);
  const size = 200 * 1024;
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => upload(`m${i}.txt`, size)));
  const results = all.flatMap((r) => r.results);
  const ok = results.filter((r) => r.ok).length;
  // 5 x 200 KiB fit in 1 MiB. Fewer may land: interleaved uploads hold
  // partial reservations, so several can fail together near the limit.
  assert.ok(ok <= 5, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.equal(r.error, 'Upload exceeds your storage quota');
  await settled();
  assert.equal(quota.pending(user().id), 0);
  assert.equal(user().used_bytes, ok * size);
  for (let i = 0; i < 8; i++) fs.rmSync(path.join(HOME, `m${i}.txt`), { force: true });
});

test('overwriting counts the replaced file as freed space', async () => {
  setUsage(0);
  const first = await upload('same.txt', 600 * 1024);
  assert.equal(first.results[0].ok, true);
  // 600 KiB used: a new 600 KiB file would not fit, a replacement of it does.
  const other = await upload('other.txt', 600 * 1024);
  assert.equal(other.results[0].ok, false);
  const again = await upload('same.txt', 600 * 1024, '&overwrite=1');
  assert.equal(again.results[0].ok, true, JSON.stringify(again));
  assert.equal(user().used_bytes, 600 * 1024);
  await settled();
  assert.equal(quota.pending(user().id), 0);
  fs.rmSync(path.join(HOME, 'same.txt'), { force: true });
});

test('failed uploads give their reservation back', async () => {
  setUsage(0);
  // Refused by the content check after all bytes arrived.
  const form = new FormData();
  form.append('file', new Blob([Buffer.concat([Buffer.from('MZ'), Buffer.alloc(5000, 1)])]), 'prog.exe');
  const blocked = await (await fetch(`${base}/api/files/upload?path=/`, { method: 'POST', headers, body: form })).json();
  assert.equal(blocked.results[0].ok, false);
  // Refused because the name exists.
  fs.writeFileSync(path.join(HOME, 'taken.txt'), 'x');
  const taken = await upload('taken.txt', 1000);
  assert.equal(taken.results[0].ok, false);
  await settled();
  assert.equal(quota.pending(user().id), 0);
  assert.deepEqual(tmpLeft(), []);
});

test('a client that disconnects mid-upload leaves no reservation and no temp file', async () => {
  setUsage(0);
  const boundary = 'xBOUNDARYx';
  const req = http.request(`${base}/api/files/upload?path=/`, {
    method: 'POST',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  req.on('error', () => { /* we cut it ourselves */ });
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\nContent-Type: text/plain\r\n\r\n`);
  req.write(Buffer.alloc(300 * 1024, 'a'));
  // Wait until the server has reserved part of it, then cut the connection.
  for (let i = 0; i < 100 && quota.pending(user().id) === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(quota.pending(user().id) > 0, 'the upload was reserving');
  req.destroy();
  await settled();
  assert.equal(quota.pending(user().id), 0);
  assert.deepEqual(tmpLeft(), []);
  assert.equal(fs.existsSync(path.join(HOME, 'cut.txt')), false);
  assert.equal(user().used_bytes, 0);
});
