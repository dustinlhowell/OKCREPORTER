# Running Nexus on Unraid

Nexus runs as a single container. It uses about 60 MB of RAM and almost no CPU when idle. Everything it stores goes into one folder in appdata.

Installing it takes about 5 minutes:

1. **Publish the image** (one time, already automated)
2. **Install the template**: paste one command
3. **Add the container**: a few clicks in the Docker tab
4. *(Optional)* **HTTPS and remote access** for phones and Google/Outlook sync

---

## 1. Publish the image (one time)

The GitHub Action in `.github/workflows/nexus-image.yml` builds the image and pushes it to
`ghcr.io/dustinlhowell/nexus` whenever something under `nexus/` changes. It publishes these tags:

| Branch | Image tag |
| --- | --- |
| the repo's default branch (currently `floater-ios`) | `:latest` (the tag the Unraid template uses) |
| any other branch | `:<branch-name>`, with `/` replaced by `-` |

1. Merge the Nexus branch into the repo's default branch (currently `floater-ios`):
   open https://github.com/dustinlhowell/OKCREPORTER/compare/floater-ios...claude/zealous-babbage-5d7nu7, click **Create pull request**, then **Merge pull request**.
2. The first time a package is published, GitHub makes it **private**. Make it public:
   GitHub → your profile → **Packages → nexus → Package settings → Change visibility → Public**.
   The image only contains the app code; your data is never part of it.

   If you'd rather keep it private, run this once on Unraid instead. You'll need a GitHub token with the `read:packages` scope:
   `docker login ghcr.io -u dustinlhowell`

> **Don't want to use a registry?** See [Build on the server](#alternative-build-on-the-server) below.

## 2. Install the template

Open **Unraid web UI → Terminal** (the `>_` icon, top right) and paste:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user /mnt/user/appdata/nexus
wget -qO /boot/config/plugins/dockerMan/templates-user/my-Nexus.xml \
  https://raw.githubusercontent.com/dustinlhowell/OKCREPORTER/HEAD/nexus/unraid/nexus.xml
echo "Template installed"
```

## 3. Add the container

1. Go to **Docker → Add Container**.
2. In **Template**, choose **Nexus** under *User templates*.
3. Check the settings:

   | Setting | Default | Notes |
   | --- | --- | --- |
   | WebUI port | `8090` | Any free port works. |
   | App data | `/mnt/user/appdata/nexus` | Keep appdata on your cache/pool SSD (see the tips). |
   | Public URL | *(empty)* | Leave empty for now. Step 4 sets it. |

   Unraid passes your server's time zone (`TZ`) to the container automatically.
4. Click **Apply**. Unraid pulls the image and starts it.
5. Click the Nexus icon and choose **WebUI**, or browse to `http://tower:8090`. Create your account.
6. Go to **Settings → Household members** and add your wife's login.

You can now use Nexus anywhere on your home network. The [app README](../README.md) explains how to write notes and use the calendar.

---

## 4. Remote access and HTTPS (optional, but recommended)

What you need depends on what you want to do:

| You want to… | LAN only | Tailscale | Public HTTPS (Cloudflare Tunnel or reverse proxy) |
| --- | :-: | :-: | :-: |
| Use Nexus at home | ✅ | ✅ | ✅ |
| Use it from your phones away from home | – | ✅ (Tailscale app on each phone) | ✅ |
| Install it on your phones as an app | – | ✅ | ✅ |
| Subscribe to the household feed in the **iPhone** Calendar app | home only | ✅ | ✅ |
| Subscribe to the household feed in **Google/Outlook** calendar | – | ❌¹ | ✅ |
| Two-way **Google/Outlook sync** (OAuth) | – | ✅² | ✅ |

¹ Google's and Microsoft's servers fetch subscribed calendars themselves, and they can't reach an address that only exists inside your tailnet. Two-way OAuth sync doesn't have this problem, because Nexus is the side that talks to Google and Microsoft.
² As long as the provider accepts your `https://….ts.net` address as a redirect URI. Microsoft does. Google normally accepts domains under `ts.net`.

### Option A: Tailscale (private, easiest, nothing exposed to the internet)

1. Install Tailscale:
   - **Unraid 7:** **Settings → Tailscale**.
   - **Unraid 6.12:** install the **Tailscale** plugin from Community Applications.

   Sign in, then turn on **MagicDNS** and **HTTPS certificates** in the Tailscale admin console under **DNS**.
2. In the Unraid terminal:
   ```bash
   tailscale serve --bg 8090
   tailscale serve status        # shows https://tower.<your-tailnet>.ts.net
   ```
3. Edit the Nexus container. Set **Public URL** to `https://tower.<your-tailnet>.ts.net` and click **Apply**.
4. Install the Tailscale app on both phones. You can share the device with your wife's Tailscale account, or add her to your tailnet.

### Option B: Cloudflare Tunnel (public HTTPS, no ports opened)

You need a domain on Cloudflare.

1. Go to **Cloudflare Zero Trust → Networks → Tunnels → Create tunnel**. Copy the token.
2. Install the **cloudflared** container from Community Applications and give it the token.
3. Add a **Public hostname** to the tunnel:
   - Hostname: `nexus.yourdomain.com`
   - Service: `http://<unraid-ip>:8090`
4. Set **Public URL** on the Nexus container to `https://nexus.yourdomain.com` and click **Apply**.
5. *(Optional, extra lock)* Put a **Cloudflare Access** policy (email login) in front of the hostname. Add a **Bypass** rule for the path `/ics/*` so Google and Outlook can still fetch your calendar feed.

### Option C: Nginx Proxy Manager or SWAG (if you already run one)

Proxy `nexus.yourdomain.com` to `http://<unraid-ip>:8090` and enable **Websockets support**. Also turn off response buffering, because live sync uses Server-Sent Events. In Nginx Proxy Manager, put this in the *Advanced* tab:

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
```

Then set **Public URL** to the https address. Nexus reads `X-Forwarded-Proto` from the proxy, so login cookies get marked secure.

---

## Ask Claude (optional)

1. Create an API key at **console.anthropic.com → API keys**.
2. Add credits under **Billing**, and set a monthly spend limit while you're there.
3. In Unraid, go to **Docker → Nexus → Edit**, paste the key into **Anthropic API key**, and click **Apply**.

**✨ Ask Claude** then works in the sidebar and on every note. Each question's token usage shows up in the container's **Logs**. Model and effort are under **Show more settings**. The [app README](../README.md#ask-claude) covers what it can do, cost and privacy.

## Google / Outlook two-way sync

Once Public URL is set to an https address, create the OAuth apps. The steps are in the [main README](../README.md#calendar-integrations-oauth). Use these redirect URIs:

```
https://<public-url>/api/oauth/google/callback
https://<public-url>/api/oauth/outlook/callback
```

To enter the IDs and secrets: edit the container, click **Show more settings**, fill in the **Google** and **Microsoft** fields, and click **Apply**. Then each of you goes to **Settings → Calendars → Connect** in Nexus and signs in with your own account.

---

## Updating

When new code is pushed to the default branch, the Docker tab shows **update ready** next to Nexus. Click **apply update**. The database is migrated in place, and your data stays in appdata.

## Backups and restore

- **Built-in snapshots:** every night Nexus writes a consistent copy of the database to `/mnt/user/appdata/nexus/backups/nexus-YYYY-MM-DD.db` and keeps the newest 14. You can change the number with *Backups to keep* in the template.
- **Appdata Backup plugin:** if you use it, the `nexus` folder is included automatically.
- **Restore:**
  ```bash
  docker stop Nexus
  cd /mnt/user/appdata/nexus
  rm -f nexus.db-wal nexus.db-shm
  cp backups/nexus-2026-11-16.db nexus.db
  docker start Nexus
  ```
- **Off-box copy:** **Settings → Export everything** in Nexus downloads a JSON copy of all notes and events.

## Tips

- **Keep appdata on an SSD.** Set the `appdata` share to your cache or pool (*Primary storage: cache, Secondary: none*). On Unraid 6.12 and later this makes it an "exclusive share", which bypasses the FUSE layer. SQLite runs fastest there and never wakes your array disks.
- **Homelab monitoring works from inside Docker.** In a `#service` note, use the server's LAN IP for the `url::` value, for example `url:: https://192.168.1.10:8006`. Self-signed certificates are fine.
- **Logs:** Docker tab → Nexus icon → **Logs**. Calendar sync problems also appear under **Settings → Calendars** in Nexus.
- **Port conflict?** Edit the container and change *WebUI port*. Nexus always listens on 8080 inside the container.

---

## Alternative: build on the server

This doesn't need GitHub Actions or a registry. In the Unraid terminal:

```bash
BRANCH=floater-ios   # the default branch; or claude/zealous-babbage-5d7nu7 to try the branch before merging
mkdir -p /mnt/user/appdata/nexus-src && cd /mnt/user/appdata/nexus-src
wget -qO- "https://github.com/dustinlhowell/OKCREPORTER/archive/refs/heads/${BRANCH}.tar.gz" | tar xz --strip-components=1
docker build -t nexus:local nexus
```

Then follow step 3, but change **Repository** to `nexus:local`. Unraid won't offer one-click updates for a locally built image. To update, run the same commands again and click **Apply** on the container.

## Alternative: Docker Compose Manager

If you use the *Docker Compose Manager* plugin, add a stack with:

```yaml
services:
  nexus:
    image: ghcr.io/dustinlhowell/nexus:latest
    container_name: nexus
    restart: unless-stopped
    ports: ["8090:8080"]
    volumes: ["/mnt/user/appdata/nexus:/data"]
    environment:
      TZ: America/Chicago
      # PUBLIC_URL: https://tower.your-tailnet.ts.net
```
