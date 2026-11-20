#!/usr/bin/env bash
# Build a single-file runner: netdash.pyz (needs Python 3.10+, no third-party deps).
set -euo pipefail
cd "$(dirname "$0")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/netdash"
cp app.py __main__.py "$STAGE/"
cp netdash/*.py "$STAGE/netdash/"
mkdir -p "$STAGE/netdash/router" "$STAGE/netdash/static" "$STAGE/netdash/data"
cp netdash/router/*.py "$STAGE/netdash/router/"
cp netdash/static/index.html netdash/static/style.css netdash/static/app.js netdash/static/scene3d.js netdash/static/theme.js netdash/static/favicon.svg "$STAGE/netdash/static/"
cp netdash/data/oui.txt "$STAGE/netdash/data/"

python3 -m zipapp "$STAGE" -p "/usr/bin/env python3" -o netdash.pyz -c
rm -rf "$STAGE"
trap - EXIT

ls -lh netdash.pyz
echo "Run with:  python3 app/netdash.pyz   (from the repository root)"
echo "       or: ./netdash.pyz   (from the app/ folder, Linux, after chmod +x)"
