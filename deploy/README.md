# Deploying the crawler to an always-on Linux box

The dashboard (Vercel) and database (Supabase) are already cloud-hosted. The
only thing tied to a local machine is the **crawler** process. Running it on a
tiny always-on VPS makes the whole system independent of your PC.

The crawler writes only to Supabase, so it needs no inbound ports, no domain,
and no web server — it runs with `--no-server`.

## 1. Create the box

Any Ubuntu 22.04 / 24.04 VPS with ~1 GB+ RAM works. Recommended: a Hetzner
Cloud **CX22** (~€4/mo, 2 GB RAM) or a DigitalOcean 1 GB droplet.

- Image: Ubuntu 24.04
- Add your SSH key during creation so you can `ssh root@<ip>`.

## 2. Run setup

SSH in and run the setup script straight from the repo:

```bash
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/g3fps/fortnitecreatoranalytics/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh
```

It installs Node, creates a service user, clones the repo to
`/opt/uefn-crawler`, installs deps, and installs the systemd service.

## 3. Add secrets

On the first run it writes an `.env` template. Fill it with the **same values
from your local `.env.local`** (only the three Supabase vars are required):

```bash
sudo nano /opt/uefn-crawler/.env
sudo systemctl start uefn-crawler
```

## 4. Verify

```bash
systemctl status uefn-crawler        # should be "active (running)"
journalctl -u uefn-crawler -f        # live logs
```

You should see it load the catalog, then either start a cycle or report
"not due yet" and sleep.

## Operating it

| Task | Command |
| --- | --- |
| Live logs | `journalctl -u uefn-crawler -f` |
| Restart | `sudo systemctl restart uefn-crawler` |
| Stop | `sudo systemctl stop uefn-crawler` |
| Status | `systemctl status uefn-crawler` |
| **Redeploy after a push** | `sudo bash /opt/uefn-crawler/deploy/setup.sh` (pulls latest, restarts) |

systemd auto-restarts the crawler on crash and on reboot, and cannot spawn a
second copy — so the duplicate-crawler and crash-loop problems from the Windows
setup can't recur here.

## After it's confirmed working

Retire the Windows crawler so only one is writing:

```powershell
Stop-ScheduledTask   -TaskName "UEFN Stats Crawler"
Disable-ScheduledTask -TaskName "UEFN Stats Crawler"
```
