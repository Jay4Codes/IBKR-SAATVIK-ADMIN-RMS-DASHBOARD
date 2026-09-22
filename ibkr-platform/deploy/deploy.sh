#!/usr/bin/env bash
# Redeploy the API, web, and worker from the working tree.
#
#   deploy/deploy.sh [/path/to/ibkr-platform]
#
# The backend is an editable install, so Python changes need only a restart.
#
# The web build is NEVER served from the working tree. `next build` deletes
# .next/ before it writes anything, so building on top of the directory the
# live server reads from takes every CSS and JS chunk offline for the length
# of the build — the server answers 500 for its own assets and the dashboard
# renders unstyled. Instead each build is assembled into a fresh release
# directory under /srv/ibkr-web/releases and the `current` symlink is flipped
# atomically once the bundle is complete. The live release is untouched while
# the build runs, so a failed build changes nothing.
#
# ibkr-gateway (and any ibkr-gateway@<id> instance) is never restarted here.
# A live gateway restart performs a real IBKR login, which sends a push to the
# phone enrolled for that username (IB Gateway has no read-only bypass) that
# expires in 180 seconds.
# Restart one deliberately, from the dashboard or by name.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

WEB_ROOT=/srv/ibkr-web
RELEASES="$WEB_ROOT/releases"
CURRENT="$WEB_ROOT/current"
KEEP_RELEASES=5

echo "── Backend checks ───────────────────────────────────────────────"
cd "$ROOT/backend"
.venv/bin/ruff check app tests
.venv/bin/pytest -q

echo "── Frontend build ───────────────────────────────────────────────"
cd "$ROOT/frontend"
npm run lint
npm run typecheck
npm test
npm run build

echo "── Assemble release ─────────────────────────────────────────────"
# Next 16 copies static/ and public/ into the standalone bundle itself, but
# that has flipped between releases. Copy them in unconditionally so the
# bundle is self-contained no matter which version of Next built it.
stamp="$(date -u +%Y%m%d-%H%M%S)"
dest="$RELEASES/$stamp"
mkdir -p "$RELEASES"
rm -rf "$dest"
cp -a .next/standalone "$dest"
rm -rf "$dest/.next/static" "$dest/public"
cp -a .next/static "$dest/.next/static"
[ -d public ] && cp -a public "$dest/public"

for required in server.js .next/static node_modules; do
    [ -e "$dest/$required" ] || { echo "release is missing $required" >&2; exit 1; }
done
find "$dest/.next/static/css" -name '*.css' -print -quit | grep -q . \
    || { echo "release has no compiled CSS" >&2; exit 1; }
echo "  $dest  ($(cat "$dest/.next/BUILD_ID"))"

# Flip in one rename so no request ever sees a half-written bundle.
ln -sfn "$dest" "$CURRENT.tmp"
mv -Tf "$CURRENT.tmp" "$CURRENT"

echo "── Restart ──────────────────────────────────────────────────────"
systemctl restart ibkr-api ibkr-worker ibkr-web
sleep 3
systemctl is-active ibkr-api ibkr-worker ibkr-web
curl -fsS http://127.0.0.1:8120/health && echo

echo "── Verify web assets ────────────────────────────────────────────"
css="$(cd "$dest/.next/static" && find css -name '*.css' | head -1)"
curl -fsS -o /dev/null "http://127.0.0.1:3020/_next/static/$css"
curl -fsS -o /dev/null http://127.0.0.1:3020/login
echo "  /login and /_next/static/$css both served"

# Keep a few releases behind so a rollback is a single symlink flip:
#   ln -sfn /srv/ibkr-web/releases/<stamp> /srv/ibkr-web/current.tmp
#   mv -Tf /srv/ibkr-web/current.tmp /srv/ibkr-web/current && systemctl restart ibkr-web
ls -1d "$RELEASES"/*/ 2>/dev/null | sort | head -n "-$KEEP_RELEASES" | while read -r old; do
    [ "$(readlink -f "$old")" = "$(readlink -f "$CURRENT")" ] && continue
    echo "  pruning $(basename "$old")"
    rm -rf "$old"
done

echo
echo "Deployed. The gateway was not restarted."
