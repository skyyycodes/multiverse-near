// Serves the static export (`out/`) the way a static host would: `/borrow/` → `out/borrow/index.html`.
//   node scripts/serve.mjs [dir=out] [port=3030]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? 3030);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

if (!existsSync(root)) {
  console.error(`no ${root}: run \`pnpm build\` first`);
  process.exit(1);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  else if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
  if (!existsSync(file)) {
    path = join(root, "404.html");
    res.writeHead(404, { "content-type": TYPES[".html"] });
    if (existsSync(path)) createReadStream(path).pipe(res);
    else res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
