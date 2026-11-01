'use strict';
// Locked folders: a folder in a user's storage with its own password, on top
// of the account sign-in. In the web app, anything inside a locked folder
// (listing, preview, download, zip, search, rename, delete, upload) needs the
// folder to be opened with its password first. An opened folder stays open for
// this sign-in session until LOCK_IDLE_MS passes without using it, until
// "Lock now", or until sign-out (the unlock rows go with the session).
// Over SFTP, locked folders are hidden and refused: SFTP can't ask for a
// second password.
//
// Paths here are display paths in the user's own storage: "/", "/programeren",
// "/programeren/projects". Locks never apply to the /repos mount.
const bcrypt = require('bcrypt');
const config = require('../config');
const { db, audit } = require('../db');

const LOCK_IDLE_MS = 15 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;               // wrong folder passwords per user per window
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 200;

class LockedError extends Error {
  constructor(lockPath, message) {
    super(message || 'This folder is locked. Enter its password to open it.');
    this.status = 423;
    this.locked = lockPath;
  }
}

class LockRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const q = {
  all: db.prepare('SELECT id, relpath FROM folder_locks WHERE user_id = ? ORDER BY relpath'),
  byPath: db.prepare('SELECT * FROM folder_locks WHERE user_id = ? AND relpath = ?'),
  insert: db.prepare('INSERT INTO folder_locks (user_id, relpath, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  remove: db.prepare('DELETE FROM folder_locks WHERE id = ?'),
  open: db.prepare('SELECT lock_id FROM folder_unlocks WHERE session_id = ? AND expires_at > ?'),
  touch: db.prepare('UPDATE folder_unlocks SET expires_at = ? WHERE session_id = ? AND lock_id = ?'),
  unlock: db.prepare('INSERT OR REPLACE INTO folder_unlocks (session_id, lock_id, expires_at) VALUES (?, ?, ?)'),
  relock: db.prepare('DELETE FROM folder_unlocks WHERE session_id = ? AND lock_id = ?'),
  expired: db.prepare('DELETE FROM folder_unlocks WHERE expires_at <= ?'),
  fails: db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = ? AND action = 'folder.unlock.fail' AND created_at > ?"),
};

const covers = (lockPath, p) => p === lockPath || p.startsWith(lockPath + '/');

// Every lock of the user: [{id, relpath}]
function locksOf(userId) {
  return q.all.all(userId);
}

// Locks that a path is in (the folder itself or anything under it). Nested
// locks are allowed; all of them have to be open.
function covering(locks, p) {
  return locks.filter((l) => covers(l.relpath, p));
}

// Locks at or below a folder: what a delete, rename or zip of it would touch.
function inside(locks, p) {
  if (p === '/') return locks;
  return locks.filter((l) => covers(p, l.relpath));
}

// Lock ids this session has open right now.
function openIds(req) {
  if (!req.session) return new Set();
  return new Set(q.open.all(req.session.id, Date.now()).map((r) => r.lock_id));
}

function touch(req, lockIds) {
  const until = Date.now() + LOCK_IDLE_MS;
  for (const id of lockIds) q.touch.run(until, req.session.id, id);
}

// A per-request view of the user's locks, so a route can check many paths
// with two queries.
function view(req) {
  const locks = locksOf(req.user.id);
  const open = locks.length ? openIds(req) : new Set();
  return {
    locks,
    open,
    isLocked: (l) => !open.has(l.id),
    // The first lock that keeps this path closed, or null.
    blocking(p, exceptId = null) {
      return covering(locks, p).find((l) => l.id !== exceptId && !open.has(l.id)) || null;
    },
    // A folder entry's lock state for listings: null, or {open: bool}.
    stateOf(p) {
      const l = locks.find((x) => x.relpath === p);
      return l ? { open: open.has(l.id) } : null;
    },
  };
}

// Throws LockedError unless every lock over `p` is open in this session; keeps
// the open ones open (the 15 minutes count from the last use).
function assertAccess(req, p, { exceptId = null } = {}) {
  const v = view(req);
  const b = v.blocking(p, exceptId);
  if (b) throw new LockedError(b.relpath);
  const used = covering(v.locks, p).map((l) => l.id).filter((id) => id !== exceptId);
  if (used.length) touch(req, used);
  return v;
}

// A delete or rename of `p` moves or destroys everything under it, so every
// lock at or below it has to be open too.
function assertInsideOpen(req, p) {
  const v = assertAccess(req, p);
  const closed = inside(v.locks, p).find((l) => v.isLocked(l));
  if (closed) {
    throw new LockedError(closed.relpath, closed.relpath === p
      ? 'This folder is locked. Enter its password first.'
      : `This folder contains the locked folder ${closed.relpath}. Open it with its password first.`);
  }
  return v;
}

function checkPassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < PASSWORD_MIN) throw new LockRequestError(`Use at least ${PASSWORD_MIN} characters`);
  if (s.length > PASSWORD_MAX) throw new LockRequestError('That password is too long');
  return s;
}

function tooManyFails(req) {
  return q.fails.get(req.user.id, Date.now() - FAIL_WINDOW_MS).n >= MAX_FAILS;
}

const log = (req, action, detail) => audit({ userId: req.user.id, username: req.user.username, action, detail, ip: req.ip });

// Put a password on a folder. The caller has checked the folder exists, is a
// folder, and isn't the root or a repo; it must also be reachable (open locks).
function createLock(req, p, password) {
  if (p === '/') throw new LockRequestError('The top of your storage cannot be locked');
  const pw = checkPassword(password);
  assertAccess(req, p);
  if (q.byPath.get(req.user.id, p)) throw new LockRequestError('This folder is already locked', 409);
  const hash = bcrypt.hashSync(pw, config.BCRYPT_COST);
  const id = q.insert.run(req.user.id, p, hash, Date.now()).lastInsertRowid;
  // Whoever just set it has it open, so they aren't thrown out of where they are.
  q.unlock.run(req.session.id, id, Date.now() + LOCK_IDLE_MS);
  log(req, 'folder.lock', p);
  return { path: p };
}

async function verify(req, p, password) {
  const lock = q.byPath.get(req.user.id, p);
  if (!lock) throw new LockRequestError('This folder is not locked', 404);
  if (tooManyFails(req)) throw new LockRequestError('Too many wrong folder passwords. Try again in 15 minutes.', 429);
  const ok = typeof password === 'string' && password.length <= PASSWORD_MAX
    && await bcrypt.compare(password, lock.password_hash);
  if (!ok) {
    log(req, 'folder.unlock.fail', p);
    throw new LockRequestError('Wrong password for this folder', 403);
  }
  return lock;
}

// Open a locked folder for this session. Locks above it must be open already.
async function unlock(req, p, password) {
  const lock = q.byPath.get(req.user.id, p);
  if (lock) assertAccess(req, p, { exceptId: lock.id });
  const l = await verify(req, p, password);
  q.expired.run(Date.now());
  q.unlock.run(req.session.id, l.id, Date.now() + LOCK_IDLE_MS);
  log(req, 'folder.unlock', p);
  return { path: p, minutes: LOCK_IDLE_MS / 60000 };
}

// Close it again now, for this session.
function relock(req, p) {
  const lock = q.byPath.get(req.user.id, p);
  if (!lock) throw new LockRequestError('This folder is not locked', 404);
  q.relock.run(req.session.id, lock.id);
  return { path: p };
}

// Take the password off. Needs the folder password, even when it's open.
async function removeLock(req, p, password) {
  const lock = q.byPath.get(req.user.id, p);
  if (lock) assertAccess(req, p, { exceptId: lock.id });
  const l = await verify(req, p, password);
  q.remove.run(l.id);
  log(req, 'folder.unlock.remove', p);
  return { path: p };
}

// A lock belongs to the folder's path, not to the files: deleting a locked
// folder keeps its lock, so a backup or sync that puts the folder back finds
// it locked again. For the same reason a folder that is or holds a locked
// folder can't be renamed: the old name would come back unlocked.
function assertRenamable(req, p) {
  const l = inside(locksOf(req.user.id), p)[0];
  if (!l) return;
  throw new LockRequestError(l.relpath === p
    ? 'A locked folder can\'t be renamed. Remove its lock first.'
    : `This folder holds the locked folder ${l.relpath}, so it can't be renamed. Remove that lock first.`, 409);
}

module.exports = {
  LOCK_IDLE_MS,
  LockedError,
  LockRequestError,
  locksOf,
  covering,
  inside,
  view,
  assertAccess,
  assertInsideOpen,
  createLock,
  unlock,
  relock,
  removeLock,
  assertRenamable,
};
