#!/bin/sh
# Renders the SUNDAY guide to PDF, entirely locally.
#   ./build.sh                                   -> uses the placeholder repo link
#   ./build.sh https://github.com/you/your-repo  -> bakes in the real link
set -e
cd "$(dirname "$0")"
REPO="${1:-github.com/YOUR-USERNAME/sunday-gesture-control}"
BROWSER="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
[ -x "$BROWSER" ] || BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

LOGO=$(base64 -i ../assets/duro-automation-logo.png | tr -d '\n')
sed -e "s|__REPO_URL__|$REPO|g" guide.html > /tmp/sunday-guide-stage.html
# logo is large, so substitute it with a file-based replacement
awk -v logo="$LOGO" '{gsub(/__LOGO__/, logo); print}' /tmp/sunday-guide-stage.html > .render.html

"$BROWSER" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="SUNDAY-Guide.pdf" --virtual-time-budget=4000 \
  "file://$(pwd)/.render.html" 2>/dev/null

rm -f .render.html /tmp/sunday-guide-stage.html
echo "Wrote $(pwd)/SUNDAY-Guide.pdf"
