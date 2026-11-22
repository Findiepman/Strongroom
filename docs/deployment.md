# Deployment guides

Longer setup guides for running Strongroom on a server. The quick start is in the [README](../README.md).

Strongroom's sign-in cookie is HTTPS-only (plain http works on `localhost` only), so
anything reachable from another device needs HTTPS in front. Two common setups follow.

## Cloudflare Tunnel (no open ports)

The `cloudflared` daemon on your server dials out to Cloudflare, which routes
your hostname to `localhost:8080` over HTTPS. Nothing is opened on your router.

For a quick test, no account needed (the URL changes every run):

```bash
cloudflared tunnel --url http://localhost:8080
```

### Permanent tunnel with your own hostname

You need a free Cloudflare account with a domain added to it (a cheap or free
domain works, as long as its nameservers point at Cloudflare).

**1. Install cloudflared**

```bash
# Debian/Ubuntu
curl -L https://pkg.cloudflare.com/cloudflared-stable-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Windows
winget install Cloudflare.cloudflared
```

**2. Sign in and create the tunnel**

```bash
cloudflared tunnel login                                # opens a browser, pick your domain
cloudflared tunnel create strongroom                    # prints the tunnel id
cloudflared tunnel route dns strongroom files.example.com
```

**3. Configure it** in `~/.cloudflared/config.yml` (Windows:
`C:\Users\<you>\.cloudflared\config.yml`):

```yaml
tunnel: strongroom
credentials-file: /home/<you>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: files.example.com
    service: http://localhost:8080
  - service: http_status:404
```

**4. Point Strongroom at it** in `.env`:

```
NODE_ENV=production
JWT_SECRET=<generate one>
TRUST_PROXY=true
HOST=127.0.0.1        # web app is only reachable through the tunnel
SFTP_HOST=0.0.0.0     # keep SFTP reachable directly (see below)
```

With Docker, set `TRUST_PROXY: "true"` and publish the web port on localhost
only: `"127.0.0.1:8080:8080"`.

**5. Run it**

```bash
cloudflared tunnel run strongroom     # foreground, good for a first test
sudo cloudflared service install      # then install it as a service (works on Windows too)
```

**SFTP and the tunnel.** The tunnel carries HTTP only. For SFTP, pick one:

- **Port forward** TCP 2222 on your router. SFTP is already encrypted.
- **Tailscale** on the server and your devices; connect to the Tailscale IP.
  Nothing is exposed publicly.
- **Through Cloudflare anyway:** add a hostname with `service: ssh://localhost:2222`,
  then each client runs `cloudflared access tcp --hostname sftp.example.com --url localhost:2222`.

Do not host the frontend separately (for example on GitHub Pages). The server
serves the whole UI, and the SameSite=Strict cookie won't cross sites anyway.

## Reverse proxy (nginx, Caddy)

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
        proxy_buffering off;        # keeps the GitHub puller's live log streaming
        proxy_read_timeout 1h;      # long uploads and downloads
    }
}
```

Set `TRUST_PROXY=true` and `HOST=127.0.0.1`. SFTP is its own protocol: expose
port 2222 directly or through your firewall, not through nginx.

With Caddy it is one line: `files.example.com { reverse_proxy 127.0.0.1:8080 }`.

## Running as a service (systemd)

```ini
# /etc/systemd/system/strongroom.service
[Unit]
Description=Strongroom file server
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

To update: `git pull && npm ci --omit=dev && sudo systemctl restart strongroom`.

## Mounting a dedicated drive as the storage root

Assuming the drive shows up as `/dev/sdb` (check with `lsblk`):

```bash
# 1. Partition and format (DESTROYS whatever is on the disk)
sudo parted /dev/sdb --script mklabel gpt mkpart primary ext4 0% 100%
sudo mkfs.ext4 -L strongroom /dev/sdb1

# 2. Create the mount point and mount it
sudo mkdir -p /srv/web
sudo mount /dev/sdb1 /srv/web

# 3. Make the mount survive reboots (use the UUID, not the device name)
sudo blkid /dev/sdb1        # copy the UUID
echo 'UUID=<uuid-here>  /srv/web  ext4  defaults,noatime  0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a   # verify fstab is valid

# 4. Create the directory layout and hand it to the service user
sudo mkdir -p /srv/web/{storage,repos,data}
sudo useradd --system --home /srv/web --shell /usr/sbin/nologin strongroom
sudo chown -R strongroom:strongroom /srv/web
sudo chmod 750 /srv/web
```

Then in `.env`:

```
STORAGE_ROOT=/srv/web/storage
REPOS_ROOT=/srv/web/repos
DATA_DIR=/srv/web/data
NODE_ENV=production
```

Keep `DATA_DIR` on the same filesystem: uploads stream to a temp file and are
moved into place with a rename, which is only atomic on the same disk.

## Storing files on a NAS (NFS)

The server keeps running Strongroom; the NAS only holds the files. Keep
`DATA_DIR` (the SQLite database) on the server's own disk: SQLite over NFS
risks corrupted locks. Everything else goes on the NAS.

On the NAS (Synology DSM): create a shared folder `strongroom`, turn on NFS
(Control Panel → File Services → NFS, max protocol NFSv4.1), then on the shared
folder add an NFS rule for the server's IP only: read/write, squash
"Map all users to admin", security `sys`, async on.

On the server:

```bash
sudo apt install nfs-common
sudo mkdir -p /srv/nas
echo '<nas-ip>:/volume1/strongroom  /srv/nas  nfs4  rw,hard,noatime,_netdev  0 0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount /srv/nas
sudo mkdir -p /srv/nas/{storage,repos,tmp}
```

`.env`:

```
STORAGE_ROOT=/srv/nas/storage
REPOS_ROOT=/srv/nas/repos
TMP_DIR=/srv/nas/tmp       # same disk as storage, so uploads land atomically
DATA_DIR=/home/<you>/strongroom-data   # stays local
```

Make the service wait for the mount, so a NAS that's down never makes
Strongroom quietly write to an empty local folder instead. Add this override
with `sudo systemctl edit strongroom`:

```ini
[Unit]
RequiresMountsFor=/srv/nas
```

Move existing files over with the service stopped:
`sudo rsync -a --info=progress2 <old STORAGE_ROOT>/ /srv/nas/storage/` (same
for repos), update `.env`, then start Strongroom again.

