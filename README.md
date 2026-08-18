# strongroom

A self-hosted personal file server for a small trusted group. Web UI, per-user
jailed SFTP, and a GitHub puller — all behind one account system.

- **Web file browser** — upload (single/batch with progress), download, delete,
  rename, folders, in-browser preview for images, PDFs and text.
- **Accounts** — admin/user roles, per-user storage quotas, audit log
  (logins, uploads, downloads, deletions), force-logout, self-service password
  change.
- **SFTP** — same credentials, every user jailed to their own directory.
- **GitHub puller** — paste a public repo URL, the server clones or
  fast-forwards it into a sandboxed directory with a live (sanitized) log.

## Stack

Node.js + Express, SQLite (better-sqlite3), bcrypt (cost 12), JWT in
httpOnly/Secure/SameSite=Strict cookies, Helmet, express-rate-limit, ssh2.
No frontend build step — plain HTML/CSS/JS.

## Requirements

- Node.js 20+ (prebuilt binaries exist for bcrypt/better-sqlite3 on x64/arm64)
- git on the server `PATH` (for the GitHub puller)
- A Linux host for production (dev works on Windows/macOS too)

## Setup

```bash
git clone <this repo> && cd strongroom
npm install
cp .env.example .env
# edit .env — at minimum set JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npm start
```

First run creates the admin account. If `ADMIN_PASSWORD` is not set in `.env`,
a random password is printed to the console **once** — sign in and change it
under Settings.

Open `http://<host>:8080`, sign in, done. Dev note: without a `.env` the server
runs entirely out of `./data/` and generates its own dev JWT secret.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Web UI / API port |
| `HOST` | `0.0.0.0` | Bind address |
| `JWT_SECRET` | dev: auto-generated | Session signing key. **Required in production** (`NODE_ENV=production`) |
| `SESSION_TTL_HOURS` | `12` | Server-side session lifetime |
| `COOKIE_SECURE` | `true` | Keep `true`. Browsers accept Secure cookies on `http://localhost` for dev |
| `STORAGE_ROOT` | `./data/storage` | Web file storage; one subfolder per user |
| `SFTP_ROOT` | `./data/sftp` | SFTP jails; users land in `<SFTP_ROOT>/<username>/` |
| `REPOS_ROOT` | `./data/repos` | Where pulled GitHub repos live |
| `DATA_DIR` | `./data` | SQLite DB, SSH host key, temp uploads, logs |
| `ADMIN_USERNAME` | `admin` | Bootstrap admin name (first run only) |
| `ADMIN_PASSWORD` | random | Bootstrap admin password (first run only) |
| `MAX_UPLOAD_BYTES` | `2147483648` | Per-file upload cap (2 GiB) |
| `DEFAULT_QUOTA_BYTES` | `10737418240` | Quota for new users (10 GiB) unless the admin sets one |
| `SFTP_ENABLED` | `true` | Turn the SFTP service on/off |
| `SFTP_PORT` | `2222` | SFTP listen port |
| `SFTP_PUBLIC_HOST` | request host | Hostname shown on the SFTP page |
| `GIT_ALLOW_ANY_HTTPS_HOST` | `false` | `true` allows any https git host, not just github.com |
| `GIT_TIMEOUT_SECONDS` | `300` | Kill a clone/pull after this long |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/caddy so rate limits see real IPs |

## Mounting the 250 GB SSD as the storage root

Assuming the SSD shows up as `/dev/sdb` (check with `lsblk`):

```bash
# 1. Partition and format (DESTROYS whatever is on the disk)
sudo parted /dev/sdb --script mklabel gpt mkpart primary ext4 0% 100%
sudo mkfs.ext4 -L strongroom /dev/sdb1

# 2. Create the mount point and mount it
sudo mkdir -p /srv/web
sudo mount /dev/sdb1 /srv/web

# 3. Make the mount survive reboots — use the UUID, not the device name
sudo blkid /dev/sdb1        # copy the UUID
echo 'UUID=<uuid-here>  /srv/web  ext4  defaults,noatime  0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a   # verify fstab is valid

# 4. Create the directory layout and hand it to the service user
sudo mkdir -p /srv/web/{storage,sftp,repos,data}
sudo useradd --system --home /srv/web --shell /usr/sbin/nologin strongroom
sudo chown -R strongroom:strongroom /srv/web
sudo chmod 750 /srv/web
```

Then in `.env`:

```
STORAGE_ROOT=/srv/web/storage
SFTP_ROOT=/srv/web/sftp
REPOS_ROOT=/srv/web/repos
DATA_DIR=/srv/web/data
NODE_ENV=production
```

Keeping `DATA_DIR` on the same filesystem matters: uploads stream to a temp
file and are moved into place with a rename, which is atomic only on the same
disk.

## Running as a service (systemd)

```ini
# /etc/systemd/system/strongroom.service
[Unit]
Description=strongroom file server
After=network.target

[Service]
User=strongroom
WorkingDirectory=/opt/strongroom
EnvironmentFile=/opt/strongroom/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/web

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now strongroom
```

## TLS / reverse proxy

Secure cookies require https for any host that is not localhost. Put the app
behind a reverse proxy that terminates TLS:

```nginx
server {
    listen 443 ssl;
    server_name files.example.com;
    # ... ssl_certificate lines ...
    client_max_body_size 2g;        # match MAX_UPLOAD_BYTES
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_buffering off;        # keeps the GitHub puller's SSE stream live
        proxy_read_timeout 1h;      # long uploads/downloads
    }
}
```

Set `TRUST_PROXY=true` and `HOST=127.0.0.1` in `.env`. SFTP (port 2222) is its
own protocol — expose it directly or via your firewall, not through nginx.

## Security model

- Auth state lives only in an httpOnly, Secure, SameSite=Strict cookie holding
  a JWT that references a server-side session row. Logout, force-logout and
  password changes delete session rows, so tokens die server-side. Nothing
  auth-related ever touches localStorage or sessionStorage.
- Passwords: bcrypt, cost 12. Login and password endpoints are rate limited;
  a global limiter backstops the whole API.
- CSRF: state-changing routes require a session-bound token sent as a header
  (delivered in-memory via `/api/auth/me`), on top of SameSite=Strict.
- Paths: every file path from a client is resolved server-side and verified to
  stay inside the user's root before any disk operation. Same jail logic for
  SFTP, where `..` cannot climb above the virtual root.
- Uploads are content-sniffed server-side: executables (PE/ELF/Mach-O) are
  rejected, and files whose extension claims image/PDF must actually be one.
  Previews are served with a restrictive CSP and `nosniff`, and anything
  text-like is forced to `text/plain` so HTML/SVG can never execute in-origin.
- Admin routes (`/admin` page and `/api/admin/*`) run a server-side role check
  on every request; hiding the UI is not the mechanism.
- The GitHub puller only spawns `git` with an argument vector (no shell),
  accepts only `https://github.com/owner/repo` URLs, jails clones to
  `REPOS_ROOT`, and never forwards raw git/shell output to the client — the UI
  gets translated progress lines; the verbatim output goes to
  `DATA_DIR/logs/git.log`.

## Notes

- Deleting a user removes the account and its sessions but leaves their files
  on disk (deliberate: a mistaken click loses no data). Clean up
  `STORAGE_ROOT/<name>` and `SFTP_ROOT/<name>` manually.
- SFTP quotas are not enforced (the SFTP tree is separate from web storage);
  the web quota is recomputed from disk at login and on the Settings page.
- The SSH host key is generated on first run at `DATA_DIR/ssh_host_rsa_key`.
  Clients will ask to trust it on first connect.
