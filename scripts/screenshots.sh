#!/bin/sh
# Generic screenshots from the mock pages in docs/demo (fictional data), via headless Chrome.
set -e
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
shot() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 --virtual-time-budget=40000 --window-size="$2" --screenshot="$ROOT/docs/screenshots/$1.png" "file://$ROOT/docs/demo/$3" >/dev/null 2>&1; echo "$1"; }
shot post-line 700,760 post.html
shot analytics-daily 820,720 analytics.html
shot popup-live 500,640 "popup.html#live"
