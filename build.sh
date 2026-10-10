#!/bin/sh
# Cloudflare Pages build: copy only the app and its public docs into dist/ (no tests or dev files).
# developers/index.html and llms-full.txt are generated: run `npm run docs` and commit them.
set -e
rm -rf dist && mkdir -p dist/docs
cp -r index.html sw.js manifest.webmanifest _headers LICENSE THIRD_PARTY.md css js icons models vendor dist/
cp -r llms.txt llms-full.txt robots.txt sitemap.xml developers dist/
cp docs/screenshot.png dist/docs/   # og:image
# Version every app file's URL with this deploy's commit, so a browser can never
# mix a new page with old cached code (Cloudflare tells browsers to keep JS/CSS
# for hours). Vendor files are immutable and keep their URLs.
V=$(printf %s "${CF_PAGES_COMMIT_SHA:-$(date +%s)}" | cut -c1-8)
sed -i -E "s#(from \"\./[a-z0-9-]+\.js)\"#\1?v=$V\"#g; s#(import\(\"\./[a-z0-9-]+\.js)\"#\1?v=$V\"#g; s#(new URL\(\"\./[a-z0-9-]+\.js)\"#\1?v=$V\"#g" dist/js/*.js
sed -i -E "s#(href|src)=\"(js/main\.js|css/app\.css)\"#\1=\"\2?v=$V\"#g" dist/index.html
echo "Built dist/ ($(du -sh dist | cut -f1))"
