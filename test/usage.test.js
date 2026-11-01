'use strict';
// Home screen storage sizes: served from the last count, recounted in the
// background, and the count never freezes the server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strongroom-usage-'));
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
const usage = require('../src/util/usage');

const HOME = path.join(config.STORAGE_ROOT, 'boss');
let server;
let base;
let headers;

const overview = async () => (await fetch(`${base}/api/user/overview`, { headers })).json();
const user = () => getUserByUsername('boss');

before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/files', require('../src/routes/files'));
  app.use('/api/user', require('../src/routes/user'));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const s = createSession(user().id, '127.0.0.1', 'test');
  headers = { cookie: `${config.COOKIE_NAME}=${jwt.sign({ sid: s.id }, config.JWT_SECRET, { algorithm: 'HS256' })}`, 'x-csrf-token': s.csrf };

  // A tree with a few thousand small files, like a code backup.
  for (let d = 0; d < 40; d++) {
    const dir = path.join(HOME, 'code', `proj${d}`, 'src');
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 60; f++) fs.writeFileSync(path.join(dir, `f${f}.txt`), 'x'.repeat(100));
  }
  fs.mkdirSync(path.join(HOME, 'photos'));
  fs.writeFileSync(path.join(HOME, 'photos', 'a.jpg'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(HOME, 'loose.txt'), 'hello');
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the first home load answers at once and counts in the background', async () => {
  const t0 = Date.now();
  const ov = await overview();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(ov.sizesPending, true);
  assert.deepEqual(ov.breakdown, []);
  await usage.refresh(user()); // joins the walk the request started
  const ov2 = await overview();
  assert.equal(ov2.sizesPending, false);
  assert.deepEqual(ov2.breakdown, [{ name: 'code', bytes: 40 * 60 * 100 }, { name: 'photos', bytes: 5000 }]);
  assert.equal(ov2.looseBytes, 5);
  assert.equal(ov2.usedBytes, 240000 + 5000 + 5);
  assert.equal(user().used_bytes, 245005);
});

test('counting never freezes the server', async () => {
  let worst = 0;
  let last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  // Other requests keep being answered while a count runs.
  const counting = usage.refresh(user());
  const t0 = Date.now();
  const r = await fetch(`${base}/api/files/list?path=/photos`, { headers });
  const listMs = Date.now() - t0;
  await counting;
  clearInterval(tick);
  assert.equal(r.status, 200);
  assert.ok(worst < 250, `event loop blocked for ${worst} ms`);
  assert.ok(listMs < 1000, `list took ${listMs} ms during a count`);
});

test('later loads use the stored count; it is redone when old or after a web change', async () => {
  fs.writeFileSync(path.join(HOME, 'photos', 'b.jpg'), Buffer.alloc(1000)); // like the NAS backup writing
  let ov = await overview();
  assert.equal(ov.breakdown.find((b) => b.name === 'photos').bytes, 5000, 'stored count, no walk');

  // Older than 10 minutes: served as is, recounted in the background.
  db.prepare('UPDATE usage_cache SET computed_at = ?').run(Date.now() - usage.MAX_AGE_MS - 1);
  ov = await overview();
  assert.equal(ov.breakdown.find((b) => b.name === 'photos').bytes, 5000);
  await usage.refresh(user());
  ov = await overview();
  assert.equal(ov.breakdown.find((b) => b.name === 'photos').bytes, 6000);

  // A web delete marks it changed: recounted on a load once the count is 15+ s old.
  const del = await (await fetch(`${base}/api/files/delete`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['/photos/b.jpg'] }),
  })).json();
  assert.equal(del.results[0].ok, true);
  db.prepare('UPDATE usage_cache SET computed_at = ?').run(Date.now() - 20 * 1000);
  await overview();
  await usage.refresh(user());
  ov = await overview();
  assert.equal(ov.breakdown.find((b) => b.name === 'photos').bytes, 5000);
});

test('deleting a big folder works and frees its size', async () => {
  const before = user().used_bytes;
  const del = await (await fetch(`${base}/api/files/delete`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['/code/proj0'] }),
  })).json();
  assert.equal(del.results[0].ok, true);
  assert.equal(fs.existsSync(path.join(HOME, 'code', 'proj0')), false);
  assert.equal(user().used_bytes, before - 6000);
});
