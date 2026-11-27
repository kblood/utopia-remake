// Checks the static server (tools/serve.mjs): what it serves, what it refuses, and that
// malformed or traversal requests do not crash it. Requests are sent with raw http.request
// so the paths reach the server unnormalised. No original game data is used.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createServer } = await import("../tools/serve.mjs");

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
}
function skip(name, why) {
  console.log(`skip ${name} (${why})`);
}

function request(port, method, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, agent: false, headers: { Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] ?? "", body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const server = createServer(root);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

try {
  const html = await request(port, "GET", "/");
  check("GET / is 200 text/html", html.status === 200 && html.type === "text/html; charset=utf-8");

  const indexHtml = await request(port, "GET", "/index.html");
  check("GET /index.html is 200 text/html", indexHtml.status === 200 && indexHtml.type === "text/html; charset=utf-8");

  if (fs.existsSync(path.join(root, "dist", "main.js"))) {
    const js = await request(port, "GET", "/dist/main.js");
    check("GET /dist/main.js is 200 javascript", js.status === 200 && js.type.startsWith("text/javascript"));
  } else {
    skip("GET /dist/main.js is 200 javascript", "dist/ is not built; run npm run build");
  }

  const refused = [
    "/original/utopia-whdload/Disk.1",
    "/src/main.ts",
    "/package.json",
    "/dist/../package.json",
    "/dist/%2e%2e/package.json",
    "/dist/..%5cpackage.json",
  ];
  for (const p of refused) {
    const r = await request(port, "GET", p);
    check(`GET ${p} is not 200`, r.status !== 200);
  }

  const post = await request(port, "POST", "/");
  check("POST / is not 200", post.status !== 200);

  const malformed = await request(port, "GET", "/dist/%E0%A4%A");
  check("malformed escape is refused (400 or 404)", malformed.status === 400 || malformed.status === 404);

  const after = await request(port, "GET", "/");
  check("server still answers after malformed escape", after.status === 200);
} catch (err) {
  check(`unexpected error: ${err.message}`, false);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failed > 0) {
  console.log(`\n${failed} serve check(s) failed`);
  process.exit(1);
}
console.log("\nall serve checks passed");
