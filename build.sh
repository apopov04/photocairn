#!/bin/sh
# Cloudflare Pages build: copy only the app and its public docs into dist/ (no tests or dev files).
# developers/index.html and llms-full.txt are generated: run `npm run docs` and commit them.
set -e
rm -rf dist && mkdir -p dist/docs
cp -r index.html sw.js manifest.webmanifest _headers LICENSE THIRD_PARTY.md css js icons models vendor dist/
cp -r llms.txt llms-full.txt robots.txt sitemap.xml developers dist/
cp docs/screenshot.png dist/docs/   # og:image
echo "Built dist/ ($(du -sh dist | cut -f1))"
