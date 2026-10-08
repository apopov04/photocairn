// Minimal static server for local testing, with the cross-origin isolation
// headers that enable multi-threaded WebAssembly (same as production _headers).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.env.ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const port = +process.env.PORT || 8080;
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}/`));
