// Static HTTP server for the browser build. Node built-ins only.
// Serves index.html (at / and /index.html) and files under dist/. Everything else is 404.
// Usage: npm start (builds, then runs this file), or PORT=8080 node tools/serve.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".css": "text/css",
};

function send(res, method, status, headers, body) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  if (method === "HEAD" || body === undefined) res.end();
  else res.end(body);
}

function sendText(res, method, status, message, extra = {}) {
  send(res, method, status, { "Content-Type": "text/plain; charset=utf-8", ...extra }, message);
}

// Returns the decoded path segments below the URL root, or null when the request
// path is not one this server serves. Throws URIError for malformed escapes.
function resolveRequestPath(rootDir, rawUrl) {
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (!pathname.startsWith("/")) return null;
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\\") || decoded.includes("\0")) return null;

  if (decoded === "/" || decoded === "/index.html") {
    return path.join(rootDir, "index.html");
  }
  if (!decoded.startsWith("/dist/")) return null;

  const segments = decoded.slice("/dist/".length).split("/");
  if (segments.some((s) => s === "." || s === ".." || s === "")) return null;

  const distDir = path.join(rootDir, "dist");
  const target = path.resolve(distDir, ...segments);
  const rel = path.relative(distDir, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

// The only files the page may read from the local folder (the WHDLoad set; disk.4 is optional).
const LOCAL_ALLOWLIST = new Set(["Disk.1", "Disk.2", "Utopia.Slave", "disk.4"]);

// Serves /local/<name> from the folder given by UTOPIA_LOCAL_DIR, for the allowlisted names only. Off unless set.
function serveLocal(res, method, localDir, name) {
  const real = path.join(localDir, name);
  fs.stat(real, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendText(res, method, 404, "not found\n");
      return;
    }
    const headers = { "Content-Type": "application/octet-stream", "Content-Length": stat.size };
    if (method === "HEAD") {
      send(res, method, 200, headers);
      return;
    }
    res.writeHead(200, { "Cache-Control": "no-store", ...headers });
    const stream = fs.createReadStream(real);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

export function createServer(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const distDir = path.join(root, "dist");
  const localDir = options.localDir ? path.resolve(options.localDir) : null;

  return http.createServer((req, res) => {
    const method = req.method ?? "GET";
    try {
      if (method !== "GET" && method !== "HEAD") {
        sendText(res, method, 405, "method not allowed\n", { Allow: "GET, HEAD" });
        return;
      }

      const pathname = (req.url ?? "/").split(/[?#]/, 1)[0];
      if (localDir && pathname.startsWith("/local/")) {
        const name = decodeURIComponent(pathname.slice("/local/".length));
        if (LOCAL_ALLOWLIST.has(name)) {
          serveLocal(res, method, localDir, name);
        } else {
          sendText(res, method, 404, "not found\n");
        }
        return;
      }

      let filePath;
      try {
        filePath = resolveRequestPath(root, req.url ?? "/");
      } catch (err) {
        if (err instanceof URIError) {
          sendText(res, method, 400, "bad request\n");
          return;
        }
        throw err;
      }
      if (filePath === null) {
        sendText(res, method, 404, "not found\n");
        return;
      }

      fs.stat(filePath, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
          sendText(res, method, 404, "not found\n");
          return;
        }
        // Symlinks must not lead outside dist/ (index.html is served from the root).
        if (filePath !== path.join(root, "index.html")) {
          let real;
          try {
            real = fs.realpathSync(filePath);
            const realDist = fs.realpathSync(distDir);
            const rel = path.relative(realDist, real);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
              sendText(res, method, 404, "not found\n");
              return;
            }
          } catch {
            sendText(res, method, 404, "not found\n");
            return;
          }
        }

        const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
        const headers = { "Content-Type": type, "Content-Length": stat.size };
        if (method === "HEAD") {
          send(res, method, 200, headers);
          return;
        }
        res.writeHead(200, { "Cache-Control": "no-store", ...headers });
        const stream = fs.createReadStream(filePath);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      });
    } catch {
      if (!res.headersSent) sendText(res, method, 500, "internal error\n");
      else res.destroy();
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }
  const server = createServer(rootDir, { localDir: process.env.UTOPIA_LOCAL_DIR });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use on 127.0.0.1; set PORT to another value`);
    } else {
      console.error(`server error: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`Utopia remake: http://127.0.0.1:${address.port}/`);
    console.log("Open the address above and pick your WHDLoad folder. Press Ctrl+C to stop.");
  });
}
