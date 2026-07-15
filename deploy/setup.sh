#!/usr/bin/env bash
# One-time setup for the UEFN Stats crawler on a fresh Ubuntu 22.04/24.04 box.
# Run as root (or with sudo) on the VPS:
#
#   sudo bash setup.sh
#
# It installs Node, creates an unprivileged service user, lays the app down in
# /opt/uefn-crawler, and installs + starts the systemd service. Idempotent:
# safe to re-run (e.g. after `git pull` to redeploy).
set -euo pipefail

APP_DIR=/opt/uefn-crawler
SERVICE_USER=uefn
REPO="${REPO:-https://github.com/g3fps/fortnitecreatoranalytics.git}"
NODE_MAJOR=20

echo "==> UEFN crawler setup starting"

# --- Node.js (NodeSource) ---
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "==> installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v)"

# --- git ---
command -v git >/dev/null 2>&1 || apt-get install -y git

# --- service user (no login shell, no home clutter) ---
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> creating service user '$SERVICE_USER'"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# --- app code ---
if [ -d "$APP_DIR/.git" ]; then
  echo "==> updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  echo "==> cloning repo into $APP_DIR"
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

echo "==> installing production dependencies"
( cd "$APP_DIR" && npm ci --omit=dev || npm install --omit=dev )

# --- .env (secrets) ---
if [ ! -f "$APP_DIR/.env" ]; then
  echo "==> writing .env template - YOU MUST FILL THIS IN"
  cat > "$APP_DIR/.env" <<'ENV'
# Fill these with the SAME values from your local .env.local, then:
#   sudo systemctl restart uefn-crawler
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# Optional tuning (defaults are fine):
# CRAWL_INTERVAL_MS=86400000
ENV
  chmod 600 "$APP_DIR/.env"
  NEEDS_ENV=1
fi

# --- ownership: app read-only to the service user; .env readable only by it ---
chown -R root:root "$APP_DIR"
chown "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# --- systemd service ---
echo "==> installing systemd service"
cp "$APP_DIR/deploy/uefn-crawler.service" /etc/systemd/system/uefn-crawler.service
systemctl daemon-reload
systemctl enable uefn-crawler

if [ "${NEEDS_ENV:-0}" = "1" ]; then
  echo
  echo "############################################################"
  echo "#  Almost done. Edit the secrets, then start the service:  #"
  echo "#                                                          #"
  echo "#    sudo nano $APP_DIR/.env                               #"
  echo "#    sudo systemctl start uefn-crawler                     #"
  echo "#                                                          #"
  echo "#  Watch it:  journalctl -u uefn-crawler -f                #"
  echo "############################################################"
else
  systemctl restart uefn-crawler
  echo "==> uefn-crawler (re)started. Watch it: journalctl -u uefn-crawler -f"
fi
