'use strict';
// Storage sizes per user (the home screen's donut and the quota gauge),
// without freezing the server.
//
// Adding up every file is slow on a big tree on a NAS (tens of thousands of
// files take seconds to minutes), and it used to run synchronously on every
// home page load and login, which blocked every other request meanwhile. Now:
//  - the walk is asynchronous (the server keeps answering while it runs),
//  - its result is stored in the database and served straight away,
//  - it's redone in the background when it's older than MAX_AGE_MS, or sooner
//    after the web app changed files (markDirty), one walk per user at a time.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, setUsedBytes } = require('../db');

const MAX_AGE_MS = 10 * 60 * 1000;   // changes over SFTP/the NAS share show up within this
const DIRTY_AGE_MS = 15 * 1000;      // after a web upload/delete: soon, but not on every click
const CONCURRENCY = 8;               // folders read at once during a walk

db.exec(`
CREATE TABLE IF NOT EXISTS usage_cache (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  computed_at INTEGER NOT NULL,
  breakdown   TEXT NOT NULL,
  loose_bytes INTEGER NOT NULL,
  used_bytes  INTEGER NOT NULL
);
`);
const q = {
  get: db.prepare('SELECT * FROM usage_cache WHERE user_id = ?'),
  put: db.prepare('INSERT OR REPLACE INTO usage_cache (user_id, computed_at, breakdown, loose_bytes, used_bytes) VALUES (?, ?, ?, ?, ?)'),
};

const running = new Map();   // userId -> Promise of the walk in progress
const dirty = new Set();     // userIds whose files changed through the web app

// Total size of all files under dir, read asynchronously, a few folders at a
// time. Symlinks are skipped; files that vanish mid-walk are ignored.
function sizeOf(dir) {
  return new Promise((resolve) => {
    let total = 0;
    let active = 0;
    const queue = [dir];
    const pump = () => {
      if (!queue.length && active === 0) return resolve(total);
      while (active < CONCURRENCY && queue.length) {
        const d = queue.pop();
        active++;
        fs.promises.readdir(d, { withFileTypes: true })
          .then(async (entries) => {
            const files = [];
            for (const e of entries) {
              if (e.isSymbolicLink()) continue;
              const p = path.join(d, e.name);
              if (e.isDirectory()) queue.push(p);
              else if (e.isFile()) files.push(p);
            }
            for (let i = 0; i < files.length; i += 32) {
              const stats = await Promise.all(files.slice(i, i + 32).map((f) => fs.promises.stat(f).catch(() => null)));
              for (const s of stats) if (s) total += s.size;
            }
          })
          .catch(() => { /* unreadable or vanished folder: skip */ })
          .finally(() => { active--; pump(); });
      }
    };
    pump();
  });
}

// Walk the user's storage now (one walk per user at a time) and store the result.
function refresh(user) {
  if (running.has(user.id)) return running.get(user.id);
  dirty.delete(user.id);
  const job = (async () => {
    const root = path.join(config.STORAGE_ROOT, user.username);
    await fs.promises.mkdir(root, { recursive: true });
    const breakdown = [];
    let looseBytes = 0;
    for (const e of await fs.promises.readdir(root, { withFileTypes: true })) {
      const p = path.join(root, e.name);
      if (e.isDirectory()) breakdown.push({ name: e.name, bytes: await sizeOf(p) });
      else if (e.isFile()) looseBytes += await fs.promises.stat(p).then((s) => s.size, () => 0);
    }
    breakdown.sort((a, b) => b.bytes - a.bytes);
    const used = breakdown.reduce((n, b) => n + b.bytes, looseBytes);
    q.put.run(user.id, Date.now(), JSON.stringify(breakdown), looseBytes, used);
    setUsedBytes(user.id, used);
    return { computedAt: Date.now(), breakdown, looseBytes, usedBytes: used };
  })().finally(() => running.delete(user.id));
  job.catch((err) => console.error('[usage]', err && err.message));
  running.set(user.id, job);
  return job;
}

function stored(userId) {
  const row = q.get.get(userId);
  if (!row) return null;
  let breakdown = [];
  try { breakdown = JSON.parse(row.breakdown); } catch { /* rebuilt on the next walk */ }
  return { computedAt: row.computed_at, breakdown, looseBytes: row.loose_bytes, usedBytes: row.used_bytes };
}

// What the home screen shows: the stored sizes right away, with a background
// walk started when they're old. `pending` means there are none yet.
function current(user) {
  const s = stored(user.id);
  const age = s ? Date.now() - s.computedAt : Infinity;
  if (age > MAX_AGE_MS || (dirty.has(user.id) && age > DIRTY_AGE_MS)) refresh(user).catch(() => {});
  if (!s) return { breakdown: [], looseBytes: 0, usedBytes: null, computedAt: null, pending: true };
  return { ...s, pending: false };
}

// The web app changed this user's files: recount soon.
function markDirty(userId) {
  dirty.add(userId);
}

module.exports = { sizeOf, refresh, current, markDirty, MAX_AGE_MS };
