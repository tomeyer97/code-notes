#!/usr/bin/env bash
# Builds the extension, then runs the journey panel's layout and click checks (shoot.mjs) in a headless Chromium.
# Usage: test/journey-map/shoot.sh [screenshot-dir] [journeys-dir]
# Needs Playwright (npm i -D playwright && npx playwright install chromium), or PLAYWRIGHT=<path to its index.mjs>;
# CHROME=<binary> picks another Chromium. Screenshots go to screenshot-dir (none without it).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
(cd "$root" && npm run -s build)
exec node "$root/test/journey-map/shoot.mjs" "$@"
