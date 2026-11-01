'use strict';
// Locked folders, from the server's shell (for a forgotten folder password).
//
//   node scripts/folder-locks.js list
//   node scripts/folder-locks.js remove <username> </folder/path>
//
// Run it from the Strongroom folder, with the same .env as the server, so it
// opens the same database. Removing a lock opens the folder to the account's
// sign-in alone again; the files themselves are not touched.
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { db, audit, getUserByUsername } = require('../src/db');

const [cmd, username, folder] = process.argv.slice(2);

if (cmd === 'list') {
  const rows = db.prepare(
    'SELECT u.username, l.relpath, l.created_at FROM folder_locks l JOIN users u ON u.id = l.user_id ORDER BY u.username, l.relpath'
  ).all();
  if (!rows.length) console.log('No locked folders.');
  for (const r of rows) console.log(`${r.username}  ${r.relpath}  (locked ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')})`);
} else if (cmd === 'remove' && username && folder) {
  const user = getUserByUsername(username);
  if (!user) { console.error(`No user "${username}".`); process.exit(1); }
  const rel = '/' + folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const r = db.prepare('DELETE FROM folder_locks WHERE user_id = ? AND relpath = ?').run(user.id, rel);
  if (!r.changes) { console.error(`${username} has no lock on ${rel}. See: node scripts/folder-locks.js list`); process.exit(1); }
  audit({ userId: user.id, username: user.username, action: 'folder.unlock.remove', detail: `${rel} (from the server shell)` });
  console.log(`Removed the lock from ${rel} for ${username}.`);
} else {
  console.log('Usage:\n  node scripts/folder-locks.js list\n  node scripts/folder-locks.js remove <username> </folder/path>');
  process.exit(cmd ? 1 : 0);
}
