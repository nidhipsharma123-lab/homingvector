#!/usr/bin/env bash
# Rasterise brand/favicon.svg into the PNG/ICO sizes browsers and iOS require, with the same headless
# Chrome the verify suite uses, so the raster is exactly what a browser draws from the SVG.
set -euo pipefail
SITE="$(cd "$(dirname "$0")/.." && pwd)"
: "${SHELL_BIN:=$(find "$HOME/.cache/ms-playwright" -name chrome-headless-shell -type f | head -1)}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
for n in 16 32 180 512; do
  printf '<html><body style="margin:0;background:#070707"><img src="file://%s/brand/favicon.svg" width="%s" height="%s" style="display:block"></body></html>' "$SITE" "$n" "$n" > "$T/i.html"
  timeout 30 "$SHELL_BIN" --headless --no-sandbox --disable-gpu --allow-file-access-from-files --hide-scrollbars \
    --force-device-scale-factor=1 --user-data-dir="$T/p$n" --window-size=$n,$n --screenshot="$T/$n.png" "file://$T/i.html" >/dev/null 2>&1
done
python3 - "$T" "$SITE/brand" <<'P'
import sys; from PIL import Image
t, out = sys.argv[1:]
for n, name in ((16,'favicon-16.png'),(32,'favicon-32.png'),(180,'apple-touch-icon-180.png'),(512,'icon-512.png')):
    im = Image.open(f'{t}/{n}.png').convert('RGB').crop((0,0,n,n)); im.save(f'{out}/{name}', optimize=True)
Image.open(f'{t}/32.png').convert('RGBA').crop((0,0,32,32)).save(f'{out}/favicon.ico', sizes=[(16,16),(32,32)])
print('icons written')
P
