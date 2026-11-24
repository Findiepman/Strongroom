'use strict';
// Bytes of uploads still in progress, per user, shared by the web upload route
// and the SFTP server. used_bytes in the database only grows when an upload
// finishes, so without this two parallel uploads (two browser tabs, web + SFTP,
// several SFTP handles) would each see the same free space and together go
// over the quota.
const { getUserById } = require('../db');

const inflight = new Map(); // userId -> bytes reserved by unfinished uploads

function pending(userId) {
  return inflight.get(userId) || 0;
}

// Try to reserve `bytes` more for this user. Returns false (and reserves
// nothing) when used + all reservations + bytes would pass the quota.
// `credit` is space the upload will free when it lands (the file it replaces).
function reserve(userId, bytes, credit = 0) {
  if (bytes <= 0) return true;
  const row = getUserById(userId);
  if (!row) return false;
  if (row.used_bytes + pending(userId) + bytes - credit > row.quota_bytes) return false;
  inflight.set(userId, pending(userId) + bytes);
  return true;
}

// Give back a reservation (the upload finished and was counted in used_bytes,
// or it failed). Never goes below zero.
function release(userId, bytes) {
  if (bytes <= 0) return;
  const left = pending(userId) - bytes;
  if (left > 0) inflight.set(userId, left);
  else inflight.delete(userId);
}

module.exports = { reserve, release, pending };
