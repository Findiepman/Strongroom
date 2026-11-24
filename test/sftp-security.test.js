'use strict';
// SFTP hardening: password-guessing limits, the shared quota ledger across
// parallel upload handles, symlinks that lead out of the jail and accounts
// deleted while a connection is open. Runs in its own temp folder like
// sftp.test.js; nothing real is touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strongroom-sec-'));
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

// Count every bcrypt check the SFTP server runs, and how many run at once.
// sftp.js calls bcrypt.compare through the module object, so this wrapper
// sees them all.
const bcrypt = require('bcrypt');
const realCompare = bcrypt.compare;
const compares = { total: 0, inflight: 0, maxInflight: 0 };
bcrypt.compare = (...args) => {
  compares.total++;
  compares.inflight++;
  compares.maxInflight = Math.max(compares.maxInflight, compares.inflight);
  return realCompare.apply(bcrypt, args).finally(() => { compares.inflight--; });
};

const { Client } = require('ssh2');
const config = require('../src/config');
const { db, getUserByUsername } = require('../src/db');
const { startSftpServer, authLimiter } = require('../src/sftp');
const { createAuthLimiter, normalizeIp } = require('../src/util/authlimit');
const quota = require('../src/util/quota');

const USER = 'boss';
const PASS = 'test-password-123';
const HOME = path.join(config.STORAGE_ROOT, USER);

let server;
let port;

const p = (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))));
const audits = (action) => db.prepare('SELECT detail FROM audit_logs WHERE action = ? ORDER BY id').all(action).map((r) => r.detail);
const userId = () => getUserByUsername(USER).id;
const usedBytes = () => getUserByUsername(USER).used_bytes;

function connect(username = USER, password = PASS) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => c.sftp((err, s) => (err ? reject(err) : resolve({ c, s }))));
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port, username, password, hostVerifier: () => true });
  });
}

// One connection that keeps offering the given passwords until the server
// accepts one, refuses them all, or hangs up. Resolves with what happened.
function tryPasswords(passwords, username = USER) {
  return new Promise((resolve) => {
    const c = new Client();
    let i = 0;
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve({ ...result, offered: i }); } };
    c.on('ready', () => { finish({ ok: true }); c.end(); });
    c.on('error', () => {});
    c.on('close', () => finish({ ok: false }));
    c.connect({
      host: '127.0.0.1',
      port,
      username,
      hostVerifier: () => true,
      authHandler: (methodsLeft, partial, cb) => {
        if (i >= passwords.length) return cb(false);
        cb({ type: 'password', username, password: passwords[i++] });
      },
    });
  });
}

before(async () => {
  server = startSftpServer();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  port = server.address().port;
});

after(() => {
  server.close();
  authLimiter.stop();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- password guessing ----------------------------------------------------

test('IPv4-mapped IPv6 addresses share the IPv4 budget', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
  // IPv6 is counted per /64: one client usually owns the whole block.
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(normalizeIp('2001:db8:0:0:ffff:1:2:3'), '2001:db8:0:0::/64');
  assert.notEqual(normalizeIp('2001:db8:0:1::1'), normalizeIp('2001:db8:0:0::1'));
  const l = createAuthLimiter({ maxFailures: 2 });
  l.recordFailure('::ffff:9.9.9.9');
  l.recordFailure('9.9.9.9');
  assert.equal(l.isBlocked('9.9.9.9'), true);
  assert.equal(l.isBlocked('::ffff:9.9.9.9'), true);
  assert.equal(l.isBlocked('9.9.9.8'), false, 'other IPs are not affected');
  l.stop();
});

test('limiter: the window passes, memory stays bounded, in-flight is capped', async () => {
  let t = 0;
  const l = createAuthLimiter({ maxFailures: 3, windowMs: 1000, maxInflight: 2, maxQueued: 1, maxEntries: 5, now: () => t });
  for (let i = 0; i < 3; i++) l.recordFailure('a');
  assert.equal(l.isBlocked('a'), true);
  assert.equal(l.firstRefusal('a'), true);
  assert.equal(l.firstRefusal('a'), false, 'only the first refusal is reported');
  t = 1000;
  assert.equal(l.isBlocked('a'), false, 'a new window starts over');

  for (let i = 0; i < 50; i++) l.recordFailure(`10.0.0.${i}`);
  assert.ok(l.size() <= 5, `map stays capped (size ${l.size()})`);
  t = 5000;
  l.prune();
  assert.equal(l.size(), 0, 'old idle entries are pruned');

  const r1 = await l.acquire('b');
  const r2 = await l.acquire('b');
  let third = null;
  const waiting = l.acquire('b').then((r) => { third = r; });
  assert.equal(await l.acquire('b'), null, 'queue full: refused');
  await new Promise((r) => setImmediate(r));
  assert.equal(third, null, 'third waits for a free slot');
  r1();
  r1(); // releasing twice must not free a second slot
  await waiting;
  assert.equal(typeof third, 'function');
  r2();
  third();
  l.stop();
});

test('one connection gets 3 password tries, then it is dropped', async () => {
  authLimiter.clear();
  const failsBefore = audits('sftp.login.fail').length;
  const before = compares.total;
  const r = await tryPasswords(['wrong-1', 'wrong-2', 'wrong-3', 'wrong-4', 'wrong-5', PASS]);
  assert.equal(r.ok, false, 'never got in, even with the right password as the 6th try');
  // The client may already have sent a 4th try when the hang-up arrives;
  // what counts is that the server only checked 3.
  assert.ok(r.offered <= 4, `offered ${r.offered}`);
  assert.equal(audits('sftp.login.fail').length - failsBefore, 3);
  assert.equal(compares.total - before, 3);
  authLimiter.clear();
});

test('after 10 failures an IP is refused without bcrypt, even with the right password', async () => {
  authLimiter.clear();
  const blockedBefore = audits('sftp.login.blocked').length;
  // 10 wrong guesses over several connections (3 per connection max).
  for (const n of [3, 3, 3, 1]) {
    const r = await tryPasswords(Array.from({ length: n }, (_, i) => `nope-${i}`));
    assert.equal(r.ok, false);
  }

  const before = compares.total;
  const started = Date.now();
  const r = await tryPasswords([PASS]);
  assert.equal(r.ok, false, '11th attempt is refused although the password is right');
  assert.equal(compares.total - before, 0, 'no bcrypt check was spent on it');
  await assert.rejects(connect(), /authentication methods failed/);
  assert.equal(compares.total - before, 0);
  assert.ok(Date.now() - started < 2000);

  // Unknown usernames are refused the same way while blocked.
  assert.equal((await tryPasswords(['x'], 'nobody')).ok, false);
  assert.equal(compares.total - before, 0);
  assert.equal(audits('sftp.login.blocked').length - blockedBefore, 1, 'audited once, not per refusal');

  // Once the window is over (here: cleared) the owner gets in again.
  authLimiter.clear();
  const { c } = await connect();
  c.end();
});

test('parallel connections from one IP run at most 2 bcrypt checks at once', async () => {
  authLimiter.clear();
  compares.maxInflight = 0;
  const before = compares.total;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => tryPasswords([`par-${i}`])));
  assert.ok(results.every((r) => !r.ok));
  assert.equal(compares.total - before, 6, 'all were checked (still under the 10 limit)');
  assert.ok(compares.maxInflight <= 2, `max in flight was ${compares.maxInflight}`);
  authLimiter.clear();
});

test('unknown usernames still cost a bcrypt check when not blocked (timing stays equal)', async () => {
  authLimiter.clear();
  const before = compares.total;
  assert.equal((await tryPasswords(['whatever'], 'no-such-user')).ok, false);
  assert.equal(compares.total - before, 1);
  authLimiter.clear();
});

// ---- quota across parallel handles -----------------------------------------

test('two parallel upload handles cannot together pass the quota', async () => {
  const id = userId();
  const { c, s } = await connect();
  const open = p(s.open.bind(s));
  const write = p(s.write.bind(s));
  const close = p(s.close.bind(s));
  const oldQuota = getUserByUsername(USER).quota_bytes;
  db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(usedBytes() + 1000, id);
  try {
    const before = usedBytes();
    const h1 = await open('/par-a.bin', 'w');
    const h2 = await open('/par-b.bin', 'w');
    await write(h1, Buffer.alloc(600, 1), 0, 600, 0);
    assert.equal(quota.pending(id), 600, 'the first handle holds its growth');
    await assert.rejects(write(h2, Buffer.alloc(600, 2), 0, 600, 0), /storage quota/);
    await close(h1);
    await assert.rejects(close(h2), /storage quota/);
    assert.equal(usedBytes(), before + 600);
    assert.ok(fs.existsSync(path.join(HOME, 'par-a.bin')));
    assert.equal(fs.existsSync(path.join(HOME, 'par-b.bin')), false);
    assert.equal(quota.pending(id), 0, 'every reservation was given back');

    // Overwriting a file gets its old size as credit.
    const h3 = await open('/par-a.bin', 'w');
    await write(h3, Buffer.alloc(900, 3), 0, 900, 0); // +300 over the old 600, 400 free
    assert.equal(quota.pending(id), 300);
    await close(h3);
    assert.equal(usedBytes(), before + 900);
    assert.equal(quota.pending(id), 0);

    // A reservation held elsewhere (a web upload in progress) counts too.
    assert.equal(quota.reserve(id, 50), true);
    const h4 = await open('/par-c.bin', 'w');
    await assert.rejects(write(h4, Buffer.alloc(60, 4), 0, 60, 0), /storage quota/);
    await assert.rejects(close(h4), /storage quota/);
    quota.release(id, 50);
    assert.equal(quota.pending(id), 0);
  } finally {
    db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(oldQuota, id);
    c.end();
  }
});

test('an upload cut off mid-way gives its reservation back', async () => {
  const id = userId();
  const { c, s } = await connect();
  const h = await p(s.open.bind(s))('/cut.bin', 'w');
  await p(s.write.bind(s))(h, Buffer.alloc(500, 5), 0, 500, 0);
  assert.equal(quota.pending(id), 500);
  c.end();
  for (let i = 0; i < 50 && quota.pending(id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(quota.pending(id), 0);
  assert.equal(fs.existsSync(path.join(HOME, 'cut.bin')), false);
});

// ---- symlinks out of the jail ------------------------------------------------

test('a symlink planted in storage cannot be followed out of the jail', async (t) => {
  const outside = path.join(TMP, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
  fs.mkdirSync(path.join(HOME, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'inner', 'mine.txt'), 'yours');
  try {
    // Junctions need no admin rights on Windows; plain dir links elsewhere.
    fs.symlinkSync(outside, path.join(HOME, 'out'), 'junction');
    fs.symlinkSync(path.join(HOME, 'inner'), path.join(HOME, 'in'), 'junction');
  } catch (err) {
    t.skip(`cannot make links here: ${err.code}`);
    return;
  }
  const { c, s } = await connect();
  const ls = p(s.readdir.bind(s));
  const get = p(s.readFile.bind(s));
  const put = p(s.writeFile.bind(s));
  const stat = p(s.stat.bind(s));
  const mkdir = p(s.mkdir.bind(s));
  const mv = p(s.rename.bind(s));
  const utimes = p(s.utimes.bind(s));
  const isDenied = (e) => e.code === 3;
  try {
    await assert.rejects(ls('/out'), isDenied);
    await assert.rejects(get('/out/secret.txt'), isDenied);
    await assert.rejects(stat('/out/secret.txt'), isDenied);
    await assert.rejects(put('/out/dropped.txt', 'x'), isDenied);
    await assert.rejects(mkdir('/out/newdir'), isDenied);
    await assert.rejects(mv('/out/secret.txt', '/stolen.txt'), isDenied);
    await assert.rejects(mv('/inner/mine.txt', '/out/mine.txt'), isDenied);
    await assert.rejects(utimes('/out/secret.txt', 1, 1), isDenied);
    assert.equal(fs.existsSync(path.join(outside, 'dropped.txt')), false);
    assert.equal(fs.existsSync(path.join(outside, 'newdir')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'not yours');
    assert.equal(fs.existsSync(path.join(HOME, 'stolen.txt')), false);

    // The listing may show the link, but not the target's details.
    const top = await ls('/');
    const out = top.find((e) => e.filename === 'out');
    assert.ok(out, 'link entry is listed');
    const real = await p(s.realpath.bind(s))('/out');
    assert.equal(real, '/out');

    // A link that stays inside the jail keeps working.
    assert.equal((await get('/in/mine.txt')).toString(), 'yours');
  } finally {
    c.end();
  }
});

test('removing a symlink removes the link, not its target', async (t) => {
  const target = path.join(TMP, 'outside-file.txt');
  fs.writeFileSync(target, 'keep me');
  try {
    fs.symlinkSync(target, path.join(HOME, 'filelink.txt'), 'file');
  } catch (err) {
    t.skip(`file symlinks need extra rights here: ${err.code}`);
    return;
  }
  const { c, s } = await connect();
  try {
    await assert.rejects(p(s.readFile.bind(s))('/filelink.txt'), (e) => e.code === 3);
    const before = usedBytes();
    await p(s.unlink.bind(s))('/filelink.txt');
    assert.equal(fs.existsSync(path.join(HOME, 'filelink.txt')), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
    assert.equal(usedBytes(), before, 'a link was never counted, so nothing is freed');
  } finally {
    c.end();
  }
});

// ---- accounts deleted while connected ------------------------------------------

test('an account deleted during the password check does not get its folder back', async () => {
  const hash = bcrypt.hashSync('race-pass-1', 4);
  db.prepare('INSERT INTO users (username, password_hash, role, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('racer', hash, 'user', 1024 * 1024, Date.now());
  authLimiter.clear();
  // Delete the account while bcrypt runs for its login.
  const orig = bcrypt.compare;
  bcrypt.compare = (...args) => {
    db.prepare('DELETE FROM users WHERE username = ?').run('racer');
    return orig.apply(bcrypt, args);
  };
  try {
    const r = await tryPasswords(['race-pass-1'], 'racer');
    assert.equal(r.ok, false);
  } finally {
    bcrypt.compare = orig;
  }
  assert.equal(fs.existsSync(path.join(config.STORAGE_ROOT, 'racer')), false);
  authLimiter.clear();
});

test('a connection of a deleted account is cut off and its folder is not recreated', async () => {
  const hash = bcrypt.hashSync('temp-pass-1', 4);
  db.prepare('INSERT INTO users (username, password_hash, role, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('temp', hash, 'user', 1024 * 1024, Date.now());
  authLimiter.clear();
  const { c, s } = await connect('temp', 'temp-pass-1');
  const closed = new Promise((r) => c.on('close', r));
  await p(s.writeFile.bind(s))('/a.txt', 'hi');
  const jail = path.join(config.STORAGE_ROOT, 'temp');
  assert.ok(fs.existsSync(path.join(jail, 'a.txt')));

  // What the admin delete does: move the folder aside, drop the row.
  fs.renameSync(jail, path.join(config.STORAGE_ROOT, `.deleted-temp-${Date.now()}`));
  db.prepare('DELETE FROM users WHERE username = ?').run('temp');

  await assert.rejects(p(s.writeFile.bind(s))('/b.txt', 'again'), (e) => e.code === 3 || /closed|No response/i.test(e.message));
  await closed;
  assert.equal(fs.existsSync(jail), false, 'the jail folder was not recreated');
});
