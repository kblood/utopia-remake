// One-step launcher for your own WHDLoad copy: checks the files, builds, starts the local server and opens the game.
// Reads the folder from UTOPIA_LOCAL_DIR, or original/utopia-whdload when that is unset. Nothing is copied or stored;
// the server only serves the four WHDLoad file names from that folder, to 127.0.0.1. Stop with Ctrl+C.
// Usage: node tools/launch-local.mjs   (or tools/Utopia.cmd, which the desktop shortcut starts)

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./serve.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localDir = path.resolve(process.env.UTOPIA_LOCAL_DIR ?? path.join(root, "original", "utopia-whdload"));
const port = Number(process.env.PORT ?? 8080);

const required = ["Disk.1", "Disk.2", "Utopia.Slave"];
const missing = required.filter((name) => !fs.existsSync(path.join(localDir, name)));
if (missing.length > 0) {
  console.error(`Missing in ${localDir}: ${missing.join(", ")}`);
  console.error("Set UTOPIA_LOCAL_DIR to the folder with your WHDLoad 1.2 (0757) files.");
  process.exit(1);
}

console.log("Building ...");
execSync("npm run build", { cwd: root, stdio: "inherit", shell: true });

const server = createServer(root, { localDir });
server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${port} is already in use. Close the other Utopia window or set PORT.` : `Server error: ${err.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/?local=1`;
  console.log(`Reading files from ${localDir}`);
  console.log(`Opening ${url}  (Ctrl+C here stops the game server)`);
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
});
