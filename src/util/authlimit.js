'use strict';
// Password-guessing limits for logins that don't go through Express (SFTP).
// The web login has express-rate-limit (10 tries per 15 minutes per IP); this
// gives SFTP the same budget, and also caps how many bcrypt checks one IP can
// have running at once, because every guess costs a full bcrypt compare and
// many parallel connections would otherwise pin the CPU.
//
// Deliberately per IP only, never per username: a username lockout would let
// anyone lock the owner out just by guessing at their name.

const net = require('net');

// "::ffff:1.2.3.4" (IPv4 on a dual-stack socket) and "1.2.3.4" are the same
// client and must share one budget. A real IPv6 client usually owns a whole
// /64 and could rotate through it for a fresh budget each time, so IPv6 is
// counted per /64.
function normalizeIp(ip) {
  const s = String(ip || '').toLowerCase();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m) return m[1];
  if (!net.isIPv6(s)) return s;
  const [head, tail = ''] = s.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (s.includes('.')) return s; // other embedded-IPv4 forms: rare, keep whole
  const groups = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

function createAuthLimiter({
  maxFailures = 10,
  windowMs = 15 * 60 * 1000,
  maxInflight = 2,
  maxQueued = 32, // rclone opens up to --transfers + --checkers connections at once
  maxEntries = 10000,
  now = Date.now,
} = {}) {
  // ip -> { failures, resetAt, inflight, waiting: [fn], noticed }
  const entries = new Map();

  const fresh = () => ({ failures: 0, resetAt: now() + windowMs, inflight: 0, waiting: [], noticed: false });

  function entryFor(ip, create) {
    let e = entries.get(ip);
    if (e && now() >= e.resetAt) {
      // Fixed window like express-rate-limit: the count starts over.
      e.failures = 0;
      e.noticed = false;
      e.resetAt = now() + windowMs;
    }
    if (!e && create) {
      if (entries.size >= maxEntries) prune();
      // Still full of IPs that are blocked or busy right now: drop the oldest
      // idle one rather than grow without bound. An attacker spraying from
      // many addresses can at worst evict a stale count, never pass the
      // in-flight cap of a live one.
      if (entries.size >= maxEntries) {
        let victim = null;
        for (const [k, v] of entries) {
          if (v.inflight !== 0 || v.waiting.length !== 0) continue;
          if (v.failures < maxFailures) { victim = k; break; } // spare blocked IPs when we can
          if (victim === null) victim = k;
        }
        if (victim !== null) entries.delete(victim);
      }
      e = fresh();
      entries.set(ip, e);
    }
    return e;
  }

  // Forget IPs whose window is over and that have nothing running.
  function prune() {
    const t = now();
    for (const [k, v] of entries) {
      if (t >= v.resetAt && v.inflight === 0 && v.waiting.length === 0) entries.delete(k);
    }
  }

  function isBlocked(rawIp) {
    const e = entryFor(normalizeIp(rawIp), false);
    return !!e && e.failures >= maxFailures;
  }

  // True only for the first refusal of a block window, so the audit log gets
  // one "blocked" line instead of one per refused guess.
  function firstRefusal(rawIp) {
    const e = entryFor(normalizeIp(rawIp), false);
    if (!e || e.noticed) return false;
    e.noticed = true;
    return true;
  }

  function recordFailure(rawIp) {
    entryFor(normalizeIp(rawIp), true).failures++;
  }

  // Wait for a free bcrypt slot for this IP. Resolves to a release function,
  // or to null when too many checks are already queued (refuse the attempt).
  function acquire(rawIp) {
    const e = entryFor(normalizeIp(rawIp), true);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = e.waiting.shift();
      if (next) next(); // hand the slot straight over; inflight stays the same
      else e.inflight--;
    };
    if (e.inflight < maxInflight) {
      e.inflight++;
      return Promise.resolve(release);
    }
    if (e.waiting.length >= maxQueued) return Promise.resolve(null);
    return new Promise((resolve) => e.waiting.push(() => resolve(release)));
  }

  // Periodic cleanup that never keeps the process alive.
  const timer = setInterval(prune, Math.min(windowMs, 60 * 1000));
  timer.unref();

  return {
    isBlocked,
    firstRefusal,
    recordFailure,
    acquire,
    prune,
    size: () => entries.size,
    clear: () => entries.clear(),
    stop: () => clearInterval(timer),
  };
}

module.exports = { createAuthLimiter, normalizeIp };
