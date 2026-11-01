# Strongroom in Windows Explorer: research note (job #22)

Research only. Nothing was built or changed in the code, and nothing was run or tested.
The facts about Strongroom come from reading the code (file:line references).
The facts about rclone, WinFsp, the Windows WebClient and Synology come from
general knowledge and should be checked when the work is done.

The boss's answers: **two-way sync** and **Windows only**.

## What Strongroom has today (from the code)

| Fact | Where |
|---|---|
| Strongroom already runs its own **SFTP server** (ssh2, port 2222) that logs in with the same accounts and passwords as the web app | `src/sftp.js`, `SFTP_PORT` in README |
| The SFTP jail is `SFTP_ROOT/<user>`, a **separate tree** from web storage at `STORAGE_ROOT/<user>`. Files sent over SFTP never show up in the web UI | `sftp.js:91`, `config.js:27-28`, README "Notes" |
| SFTP writes skip everything web uploads do: no quota, no executable or content check (`validateUpload`), no `files` table row (so they never appear under "recent uploads"), and only a weak audit entry at OPEN | `sftp.js:155-198` vs `routes/files.js:157-275` |
| SFTP REMOVE and RENAME don't touch the `files` table, and RENAME isn't audited | `sftp.js:244-261` |
| `SETSTAT`/`FSETSTAT` are no-ops, so clients **can't set file modification times** | `sftp.js:263-264` |
| The web API accepts only a session cookie (JWT) plus a CSRF header. There's no token or Basic auth, so nothing except a browser can use it today | `middleware/auth.js:29-80` |
| The web tree has a virtual read-only `/repos` folder, and the name `repos` is reserved at the top level. SFTP doesn't know about either | `files.js:24-47` |
| The Cloudflare Tunnel carries only HTTP. To reach SFTP you need the LAN, Tailscale or a port forward | README "SFTP and the tunnel" |
| `.fbx` files are fine: only executables (PE/ELF/Mach-O) and fake images or PDFs are blocked. The per-file cap is 2 GiB (`MAX_UPLOAD_BYTES`) | `util/filetype.js` `validateUpload` |

So the "upload pipe" an Explorer folder would need already exists: SFTP. It just
writes into the wrong tree, skips the checks, and ignores timestamps.

## Options

| | Option | How it feels in Explorer | Effort | What Strongroom needs | Drawbacks |
|---|---|---|---|---|---|
| **A** | **rclone bisync over SFTP**, run by Task Scheduler every few minutes | A real local folder (say `C:\Strongroom`) that syncs both ways. Works offline. The closest thing to OneDrive without on-demand files | Low-medium: about 1 day of Strongroom changes plus 1 hour of PC setup | The shared changes (below), with real mtime support the most important | Not instant (it syncs every N minutes, no live icons). Needs a `--resync` first run. A conflict keeps both copies, renamed with a suffix. A delete on either side is permanent (Strongroom has no trash) |
| **B** | **Drive letter over SFTP** (rclone mount + WinFsp, or SSHFS-Win) | `S:` drive, live view of the server | Low: it can work today against the current SFTP tree | The same shared changes, so the files land in web storage | No offline copy, so it needs the server reachable. Slow over Tailscale or the internet for big folders. It isn't "sync", it's a remote disk |
| **C** | **WebDAV endpoint** in Strongroom + Windows "Map network drive" | Native mapped drive, no extra software | Medium-high: a new WebDAV router, a new auth path (Basic auth over HTTPS) and lock handling | A new auth method beside the cookie+CSRF, plus all the upload checks on PUT | The Windows WebClient is flaky. It needs HTTPS and has a **50 MB file limit by default**, which you lift with a registry change (only with the boss's OK). Big .fbx files would hit that limit. Still no offline copy |
| **D** | **Own tray app** (a sync client, or the Windows Cloud Files API for OneDrive-style placeholder files) | Exactly like OneDrive, with on-demand files and status icons | High: weeks | A token API, a change feed and conflict rules | By far the most work and upkeep for one user |
| **E** | **Synology Drive Client** syncing with the DS214play | Very OneDrive-like, made by Synology | Low, if the NAS supports it | Nothing, because it **bypasses Strongroom** entirely | No Strongroom accounts, quota, audit or file checks. Files it writes behind Strongroom's back (if STORAGE_ROOT is on the NAS) won't be in the `files` table. The DS214play is an old model: check that it can run Synology Drive Server (DSM 7.x) and whether the Windows client still supports on-demand sync with it. NOT VERIFIED |

## Shared Strongroom changes (needed for A and B; follow-up work for the boss to approve, not part of this job)

1. **One tree.** Point the SFTP jail at `STORAGE_ROOT/<user>`, either in code or with an option like
   `SFTP_SHARES_STORAGE=true`, so SFTP and the web UI see the same files. Keep `/repos` out
   of SFTP and refuse the name `repos` at the top level, so a sync tool can never write
   to `REPOS_ROOT`.
2. **Same rules as web upload, on SFTP CLOSE.** Run `validateUpload`, check the quota,
   then write the `files` row plus an `upload` audit entry. If a check fails, delete the file and
   return a failure status. rclone then reports that file as failed, and bisync retries it
   on every run, so the log should say why (for example, "executable blocked"). Better still,
   write SFTP uploads to a temp name and rename them in place on success, like the web path.
3. **Delete/rename bookkeeping.** Update or remove `files` rows and audit entries on SFTP REMOVE,
   RMDIR and RENAME. Two-way sync does a lot of these.
4. **Real timestamps.** Make SETSTAT/FSETSTAT apply `mtime` with `fs.utimes`, inside the jail.
   Without this, bisync would see every file as changed. The cheaper fallback is
   `--sftp-set-modtime=false --size-only`, which needs no code but misses edits that keep
   the size the same, so it's not recommended for two-way sync.
5. Nice to have: a small **trash folder** (delete = move to `.trash/`). That turns sync mistakes
   into something you can undo.

## Recommendation: Option A (rclone bisync over Strongroom's own SFTP)

It's the only cheap option that gives what the boss asked for: a real folder in Explorer
with **two-way** sync, working offline. It also reuses the SFTP server Strongroom
already has. Option B can be added on the same setup for free if he also wants a live drive letter.
Option E is worth a 10-minute check on the NAS, but it bypasses Strongroom's accounts and checks.

Rough plan:

1. **Strongroom (about 1 day, needs the boss's go-ahead):** shared changes 1-4 above, plus tests.
2. **Network:** reach SFTP port 2222 from the PC over the LAN, or with Tailscale when away from home
   (the tunnel won't carry SFTP).
3. **On the PC:** `winget install Rclone.Rclone`. Then run `rclone config` to set up an `sftp` remote named
   `strongroom` (host, port 2222, user, password, with rclone storing it obscured in its config).
4. **Back up** `STORAGE_ROOT/<boss>` on the server first.
5. First run, as a dry run:
   `rclone bisync C:\Strongroom strongroom: --resync --dry-run -v`, then the same again without `--dry-run`.
6. **Schedule it:** in Task Scheduler, every 5-10 minutes run
   `rclone bisync C:\Strongroom strongroom: --resilient --recover --max-delete 10 --conflict-resolve newer --log-file ...`
   (`--max-delete` stops a run that would delete a lot, as a guard against mistakes). Check the flag names against
   the installed rclone version.
7. Pin `C:\Strongroom` to Quick Access. Then dropping files in = uploading to Strongroom.

Rclone's sync doesn't respect the web app's size or upload rules until change 2 is done, so do
step 1 before pointing the sync at real files.

## The NAS (DS214play)

- **For A/B it fits behind Strongroom, not in front of it.** The README already describes putting
  `STORAGE_ROOT` (and `TMP_DIR`) on the NAS over NFS, with the database kept local. Sync then goes
  PC ⇄ Strongroom SFTP ⇄ NAS disk, and nothing changes on the PC side.
- **Option E** uses the NAS directly. It's simpler if the boss mainly wants NAS files in
  Explorer, but those files aren't Strongroom files (no accounts, quota or audit). Don't point
  Synology Drive and Strongroom at the same folder.

## The .fbx files

They aren't blocked (`validateUpload` only stops executables and fake images or PDFs). Large ones
are fine under the 2 GiB cap for A/B. Option C would hit the WebClient's 50 MB default.
Note: a synced folder that contains `.exe`/`.dll` files would have those rejected on every
run once change 2 is in place, so keep programs out of the sync folder.
