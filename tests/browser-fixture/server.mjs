import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function fixtureHandler(request, response) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, fixture: "controlmac-browser" });
    return;
  }

  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const candidate = path.resolve(fixtureRoot, relativePath);
  if (candidate !== fixtureRoot && !candidate.startsWith(`${fixtureRoot}${path.sep}`)) {
    sendJson(response, 403, { ok: false, error: "path_outside_fixture" });
    return;
  }

  try {
    const [rootPath, candidatePath] = await Promise.all([realpath(fixtureRoot), realpath(candidate)]);
    if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${path.sep}`)) {
      sendJson(response, 403, { ok: false, error: "path_outside_fixture" });
      return;
    }
    const details = await lstat(candidatePath);
    if (!details.isFile()) {
      throw new Error("not a file");
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": details.size,
      "content-type": contentTypes.get(path.extname(candidatePath)) ?? "application/octet-stream",
    });
    createReadStream(candidatePath).pipe(response);
  } catch {
    sendJson(response, 404, { ok: false, error: "not_found" });
  }
}

export async function startFixtureServer({ host = "127.0.0.1", port = 0 } = {}) {
  const server = http.createServer((request, response) => {
    fixtureHandler(request, response).catch((error) => {
      sendJson(response, 500, { ok: false, error: error.message });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not bind to a TCP address");
  }
  const baseUrl = `http://${host}:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    server,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CONTROLMAC_FIXTURE_PORT ?? "4173");
  const host = process.env.CONTROLMAC_FIXTURE_HOST ?? "127.0.0.1";
  const running = await startFixtureServer({ host, port });
  process.stdout.write(`${JSON.stringify({ event: "fixture_ready", url: running.baseUrl })}\n`);
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
