# Strongroom as a synced folder in Windows Explorer (rclone bisync)

This is option A from `docs/explorer-sync-research.md`. You get a normal folder on
your PC (here `C:\Strongroom`). Anything you drop in, change, rename or delete there
is synced both ways with your Strongroom files (on the NAS, `STORAGE_ROOT=/srv/nas/storage`)
every few minutes. It works offline and catches up when the server is reachable again.

It is **not** instant like OneDrive. There are no status icons and no "files on demand":
every file is a full local copy.

Fill in these placeholders as you go:

| Placeholder | What it is | Example |
|---|---|---|
| `<HOST>` | The Strongroom server's LAN IP, or its Tailscale name when you're away | `192.168.1.20` or `strongroom.tail1234.ts.net` |
| `<PORT>` | The SFTP port (`SFTP_PORT`) | `2222` |
| `<USER>` | Your Strongroom username (the same login as the web app) | `fin` |
| `C:\Strongroom` | The folder on your PC that syncs | any empty folder |
| `C:\Strongroom-sync` | Where the sync script, filters and log live. Keep it **outside** the synced folder | |

> Flag names were written for rclone **v1.66 or newer**. Run `rclone version` and
> `rclone bisync --help` and check them against the flags used below before the first run.

---

## 0. Before you start (on the server)

1. **Deploy the Strongroom version with the SFTP changes (job #24).** Without it, SFTP
   writes to a separate tree with no checks and no timestamps, so don't sync before that.
2. **Old SFTP files.** If anything is still in the old `SFTP_ROOT/<USER>` tree, move it into
   `STORAGE_ROOT/<USER>` by hand first (see "Upgrading: SFTP now shares web storage" in the README).
3. **Back up** `/srv/nas/storage/<USER>`, for example with a Synology snapshot or a copy
   to another share. A delete on either side is synced and **permanent**, because Strongroom has no trash.
4. **Reachability.** SFTP does not go through the Cloudflare tunnel. From the PC you need
   the LAN, or Tailscale when you're away. Check it from PowerShell:
   `Test-NetConnection <HOST> -Port <PORT>` must say `TcpTestSucceeded : True`.

## 1. Install rclone

In PowerShell:

```powershell
winget install Rclone.Rclone
```

Close PowerShell, open a new one, and check it with `rclone version`.

## 2. Pin the server's host key (recommended)

This makes rclone refuse to connect to anything pretending to be your server:

```powershell
mkdir C:\Strongroom-sync
ssh-keyscan -p <PORT> <HOST> | Out-File -Encoding ascii C:\Strongroom-sync\known_hosts
type C:\Strongroom-sync\known_hosts
```

You should see one line containing `ssh-rsa`. If `ssh-keyscan` is missing, enable
"OpenSSH Client" under Settings → System → Optional features, or skip this step and
leave `known_hosts_file` out below.

## 3. Create the `strongroom` remote

Run `rclone config` and answer the prompts:

- `n` (new remote). Name: `strongroom`
- Storage: `sftp`
- host: `<HOST>`
- user: `<USER>`
- port: `<PORT>`
- pass: `y`, then type your Strongroom password twice. rclone stores it **obscured**
  in `%APPDATA%\rclone\rclone.conf`. That isn't strong encryption, so keep that file private.
- key_file and the other key questions: press Enter to leave them empty
- `Edit advanced config?` → `y`, then set:
  - `known_hosts_file` = `C:\Strongroom-sync\known_hosts` (if you did step 2)
  - `shell_type` = `none` (Strongroom only speaks SFTP and has no remote shell)
  - `disable_hashcheck` = `true` (same reason: no remote md5sum)
  - `set_modtime` = `true` (the default. Strongroom now keeps file times, and bisync relies on them)
  - leave everything else at its default
- `q` to quit.

Test it:

```powershell
rclone lsd strongroom:
rclone ls strongroom: --max-depth 1
```

You should see the same files and folders as on the web Files page (but no `repos`.
That folder is web-only and deliberately left out of SFTP).

## 4. Make a filters file

Create `C:\Strongroom-sync\filters.txt` with this content. It keeps Windows and Office
clutter out of the sync. It also keeps out programs, because Strongroom refuses `.exe`/`.dll`
and other executables, and they would otherwise fail on every run:

```
- desktop.ini
- Thumbs.db
- ~$*
- *.tmp
- *.exe
- *.dll
- *.msi
- *.sys
```

(If you change this file later, bisync asks for a new `--resync`, which is step 6 again.)

## 5. First sync: dry run, then for real

Start with an **empty** `C:\Strongroom`, so the first run just downloads everything from Strongroom:

```powershell
mkdir C:\Strongroom
rclone bisync C:\Strongroom strongroom: --resync --filters-file C:\Strongroom-sync\filters.txt --create-empty-src-dirs --dry-run -v
```

Read the output. It should list your server files as "copy to Path1" and nothing as deleted.
If that looks right, run the same command **without `--dry-run`**:

```powershell
rclone bisync C:\Strongroom strongroom: --resync --filters-file C:\Strongroom-sync\filters.txt --create-empty-src-dirs -v
```

## 6. The regular sync command

Create `C:\Strongroom-sync\sync.cmd`:

```bat
@echo off
rclone bisync C:\Strongroom strongroom: ^
  --filters-file C:\Strongroom-sync\filters.txt ^
  --create-empty-src-dirs ^
  --resilient --recover --max-lock 15m ^
  --conflict-resolve newer --conflict-loser num ^
  --max-delete 10 ^
  --log-file C:\Strongroom-sync\bisync.log --log-level INFO
```

What the important flags do:

- **No `--inplace`, on purpose.** rclone uploads to `name.xxxx.partial` and then renames it
  over the real file. If Strongroom refuses the new version (quota, executable, fake image),
  rclone throws away only the `.partial`, and your old copy on the server stays.
  With `--inplace`, rclone would delete the real file after a refused upload.
  Strongroom blocks that delete for a minute, but don't rely on it.
  A partial download to the PC also never replaces a good local file. Expect the audit log
  to show each upload as `sftp.upload …partial` followed by `sftp.rename … -> name`.
- Files are compared by size and modification time (the bisync default). Strongroom keeps
  the times rclone sets, so unchanged files are left alone.
- `--max-delete 10`: a safety brake. If a run would delete **more than 10% of the files**
  on either side, it stops instead. In bisync this number is a percentage.
- `--conflict-resolve newer --conflict-loser num`: if a file changed on both sides, the
  newer one wins, and the other copy is kept next to it with a `.conflict1` suffix.
- `--resilient --recover --max-lock 15m`: a run that was cut off (PC asleep, Wi-Fi gone)
  heals itself on the next run instead of demanding a `--resync`.

Run `C:\Strongroom-sync\sync.cmd` once by hand and check that `bisync.log` ends without errors.

## 7. Run it every 5 minutes (Task Scheduler)

1. Open **Task Scheduler** → **Create Task…** (not "Basic Task").
2. **General:** Name `Strongroom sync`. Choose "Run whether user is logged on or not"
   (this hides the console window). Use your own Windows account, because rclone's config lives under it.
3. **Triggers:** New… → "At log on", and tick "Repeat task every **5 minutes**" for a duration of **Indefinitely**.
4. **Actions:** New… → Start a program → `C:\Strongroom-sync\sync.cmd`.
5. **Conditions:** tick "Start only if the following network connection is available" → Any connection.
6. **Settings:** "If the task is already running" → **Do not start a new instance**.
7. OK, and enter your Windows password when asked.

To pause syncing, right-click the task and choose **Disable**.

## 8. Put it in Explorer

In Explorer, right-click `C:\Strongroom` and choose **Pin to Quick access**. From then on, dropping
files there uploads them to Strongroom within a few minutes.

## 9. Check that it works

- Drop a small file in `C:\Strongroom`, wait for the next run (or run `sync.cmd`), then open the
  web app. The file shows under **Recent uploads**, and the admin **Activity** page has an `sftp.upload` entry.
- Rename it in Explorer → after the next run the web app shows the new name (`sftp.rename` in Activity).
- Upload a file in the web app → it appears in `C:\Strongroom` after the next run.
- Modified dates in Explorer match the originals (Strongroom keeps file times).

## What to expect

- **Refused files.** A file Strongroom refuses (an executable, a "`.png`" that isn't a PNG,
  over your quota, over the 2 GiB per-file limit) shows in `bisync.log` with the reason
  (for example `Executable files are not allowed`). It also shows as `upload.blocked` in the
  admin Activity page. bisync retries it on every run until you remove or fix it on the PC.
- **Quota.** PC uploads count against the same quota as web uploads. While a changed file is being
  uploaded, the old and the new copy briefly both count, so near the limit a big edit can be
  refused until you free some space.
- **Deletes are permanent** on both sides. The 10% brake catches big mistakes, not single files.
  Keep server backups.
- **`repos`** never syncs. Don't create a top-level folder called `repos` in `C:\Strongroom`:
  Strongroom refuses that name, so bisync would keep failing on it.
- **Names.** Strongroom uses the same name rules as Windows, so `<>:"|?*` and names like `CON` are refused.

## Troubleshooting

| Symptom in `bisync.log` | What to do |
|---|---|
| `too many deletes` / max-delete abort | Check what was about to be deleted. If it's intended, run `sync.cmd` once more with `--force` added |
| `must run --resync` | Something serious went wrong. Read the log above it, fix the cause, then do step 5 again (dry run first) |
| `connection refused` / timeouts | The server isn't reachable: check the LAN/Tailscale and `Test-NetConnection` from step 0 |
| `ssh: handshake failed: knownhosts: key mismatch` | The server's host key changed. Only if you know why (for example a reinstall), redo step 2 |
| A file listed as failed on every run | It's being refused. The reason is on the same line; see "Refused files" above |
