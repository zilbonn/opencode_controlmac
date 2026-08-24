import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LauncherError,
  ensureBrowser,
  findProfileLocks,
  getLauncherConfig,
  inspectLauncherState,
  main,
  probeCdp,
  readDevToolsActivePort,
  runMcp,
} from "../scripts/chrome-beta-mcp.mjs";

const legacyCdpName = (suffix) => ["CONTROLMAC", "CDP", suffix].join("_");

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function startCdpServer(options = {}) {
  let serverAddress;
  const webSocketPath =
    options.webSocketPath ?? "/devtools/browser/profile-fixture";
  const server = await startServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url !== "/json/version") {
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    const host = options.reportedHost ?? "127.0.0.1";
    const port = options.reportedPort ?? serverAddress.port;
    const reportedPath = options.reportedPath ?? webSocketPath;
    response.end(
      JSON.stringify({
        Browser: options.browser ?? "FixtureChrome/1.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://${host}:${port}${reportedPath}`,
      }),
    );
  });
  serverAddress = server;
  return { ...server, webSocketPath };
}

async function closedPort() {
  const temporary = await startServer((_request, response) => response.end());
  const port = temporary.port;
  await temporary.close();
  return port;
}

async function executable(filePath, contents = "#!/bin/sh\nexit 0\n") {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function temporaryRoot(t, prefix = "controlmac-launcher-test-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function dedicatedConfig(root, overrides = {}) {
  const profilePath = path.join(root, "profile");
  return {
    connectionMode: "dedicated-profile",
    cdpUrl: null,
    chromePath: path.join(root, "chrome"),
    mcpPath: path.join(root, "chrome-devtools-mcp"),
    profilePath,
    devToolsActivePortPath: path.join(profilePath, "DevToolsActivePort"),
    logPath: path.join(root, "logs", "mcp.log"),
    startupTimeoutMs: 1_500,
    pollIntervalMs: 20,
    ...overrides,
  };
}

async function writeActivePort(config, port, webSocketPath) {
  await mkdir(config.profilePath, { recursive: true });
  await writeFile(
    config.devToolsActivePortPath,
    `${port}\n${webSocketPath}\n`,
    "utf8",
  );
}

async function stopFixtureProcess(pidPath) {
  let pid;
  try {
    pid = Number(await readFile(pidPath, "utf8"));
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }
}

test("launcher config defaults to dedicated profile ownership", () => {
  const config = getLauncherConfig({
    HOME: "/ignored",
    CONTROLMAC_HOME: "/tmp/controlmac-test-home",
    CONTROLMAC_CHROME_PATH: "~/bin/chrome-beta",
    CONTROLMAC_CHROME_USER_DATA_DIR: "~/profile",
    CONTROLMAC_CHROME_MCP_PATH: "~/bin/chrome-devtools-mcp",
    CONTROLMAC_CHROME_MCP_LOG_PATH: "~/logs/devtools.log",
    CONTROLMAC_STARTUP_TIMEOUT_MS: "4321",
    CONTROLMAC_POLL_INTERVAL_MS: "17",
  });

  assert.equal(config.connectionMode, "dedicated-profile");
  assert.equal(config.cdpUrl, null);
  assert.equal(config.chromePath, "/tmp/controlmac-test-home/bin/chrome-beta");
  assert.equal(config.profilePath, "/tmp/controlmac-test-home/profile");
  assert.equal(
    config.devToolsActivePortPath,
    "/tmp/controlmac-test-home/profile/DevToolsActivePort",
  );
  assert.equal(
    config.mcpPath,
    "/tmp/controlmac-test-home/bin/chrome-devtools-mcp",
  );
  assert.equal(config.logPath, "/tmp/controlmac-test-home/logs/devtools.log");
  assert.equal(config.startupTimeoutMs, 4321);
  assert.equal(config.pollIntervalMs, 17);
});

test("explicit CDP URL selects connect-only mode", () => {
  const config = getLauncherConfig({
    CONTROLMAC_HOME: "/tmp/controlmac-external-home",
    CONTROLMAC_CDP_URL: "http://127.0.0.1:9444/",
  });
  assert.equal(config.connectionMode, "external");
  assert.equal(config.cdpUrl, "http://127.0.0.1:9444");
});

test("launcher rejects invalid values and retired host/port overrides", () => {
  assert.throws(
    () => getLauncherConfig({ CONTROLMAC_CDP_URL: "file:///tmp/socket" }),
    (error) =>
      error instanceof LauncherError && error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () => getLauncherConfig({ CONTROLMAC_STARTUP_TIMEOUT_MS: "0" }),
    (error) =>
      error instanceof LauncherError && error.code === "INVALID_CONFIGURATION",
  );
  const credentialUrl = [
    "http://fixture-user:",
    "fixture-secret",
    "@127.0.0.1:9444",
  ].join("");
  assert.throws(
    () => getLauncherConfig({ CONTROLMAC_CDP_URL: credentialUrl }),
    (error) =>
      error instanceof LauncherError &&
      error.code === "INVALID_CONFIGURATION" &&
      !error.message.includes("fixture-user") &&
      !error.message.includes("fixture-secret"),
  );
  for (const nonOriginUrl of [
    "http://127.0.0.1:9444/devtools",
    "http://127.0.0.1:9444/?key=value",
    "http://127.0.0.1:9444/#fragment",
  ]) {
    assert.throws(
      () => getLauncherConfig({ CONTROLMAC_CDP_URL: nonOriginUrl }),
      (error) =>
        error instanceof LauncherError && error.code === "INVALID_CONFIGURATION",
    );
  }
  for (const retiredName of [legacyCdpName("HOST"), legacyCdpName("PORT")]) {
    assert.throws(
      () => getLauncherConfig({ [retiredName]: "legacy-value" }),
      (error) =>
        error instanceof LauncherError &&
        error.code === "INVALID_CONFIGURATION" &&
        error.message.includes("were removed"),
    );
  }
});

test("DevToolsActivePort parser accepts only a valid port and relative browser path", async (t) => {
  const root = await temporaryRoot(t, "controlmac-active-port-test-");
  const activePortPath = path.join(root, "DevToolsActivePort");

  assert.equal((await readDevToolsActivePort(activePortPath)).status, "missing");

  const invalidContents = [
    "",
    "abc\n/devtools/browser/id\n",
    "1e3\n/devtools/browser/id\n",
    "+1234\n/devtools/browser/id\n",
    " 1234\n/devtools/browser/id\n",
    "0\n/devtools/browser/id\n",
    "65536\n/devtools/browser/id\n",
    "1234\n",
    "1234\nhttps://example.test/devtools/browser/id\n",
    "1234\n//example.test/devtools/browser/id\n",
    "1234\n/devtools/browser/id?query=1\n",
    "1234\n/devtools/browser/id\nextra\n",
  ];
  for (const contents of invalidContents) {
    await writeFile(activePortPath, contents, "utf8");
    assert.equal(
      (await readDevToolsActivePort(activePortPath)).status,
      "invalid",
      `unexpected valid parse for ${JSON.stringify(contents)}`,
    );
  }

  await writeFile(
    activePortPath,
    "43123\n/devtools/browser/owned-fixture\n",
    "utf8",
  );
  assert.deepEqual(await readDevToolsActivePort(activePortPath), {
    status: "valid",
    path: activePortPath,
    port: 43123,
    webSocketPath: "/devtools/browser/owned-fixture",
    cdpUrl: "http://127.0.0.1:43123",
    error: null,
  });
});

test("CDP ownership requires loopback host, matching port, and exact WebSocket path", async (t) => {
  const exact = await startCdpServer();
  t.after(exact.close);
  const expected = {
    port: exact.port,
    webSocketPath: exact.webSocketPath,
  };
  const valid = await probeCdp(exact.baseUrl, 1_000, expected);
  assert.equal(valid.ok, true);
  assert.equal(valid.browser, "FixtureChrome/1.0");
  assert.equal(
    valid.webSocketDebuggerUrl,
    `ws://127.0.0.1:${exact.port}${exact.webSocketPath}`,
  );

  const wrongHost = await startCdpServer({ reportedHost: "example.test" });
  t.after(wrongHost.close);
  assert.match(
    (await probeCdp(wrongHost.baseUrl, 1_000, {
      port: wrongHost.port,
      webSocketPath: wrongHost.webSocketPath,
    })).error,
    /not loopback/,
  );

  const wrongPort = await startCdpServer();
  t.after(wrongPort.close);
  assert.match(
    (await probeCdp(wrongPort.baseUrl, 1_000, {
      port: wrongPort.port + 1,
      webSocketPath: wrongPort.webSocketPath,
    })).error,
    /port does not match/,
  );

  const wrongPath = await startCdpServer({
    reportedPath: "/devtools/browser/unrelated",
  });
  t.after(wrongPath.close);
  assert.match(
    (await probeCdp(wrongPath.baseUrl, 1_000, {
      port: wrongPath.port,
      webSocketPath: wrongPath.webSocketPath,
    })).error,
    /path does not match/,
  );

  const redirected = await startServer((_request, response) => {
    response.writeHead(302, { location: `${exact.baseUrl}/json/version` });
    response.end();
  });
  t.after(redirected.close);
  assert.equal(
    (await probeCdp(redirected.baseUrl, 1_000, expected)).ok,
    false,
    "profile ownership must not follow redirects to another endpoint",
  );
});

test("an unrelated valid CDP endpoint is never treated as profile-owned", async (t) => {
  const root = await temporaryRoot(t);
  const config = dedicatedConfig(root);
  await mkdir(config.profilePath, { recursive: true });
  await executable(config.chromePath);
  await executable(config.mcpPath);

  const unrelated = await startCdpServer({
    webSocketPath: "/devtools/browser/profile-owned",
    reportedPath: "/devtools/browser/unrelated",
  });
  t.after(unrelated.close);
  await writeActivePort(config, unrelated.port, unrelated.webSocketPath);

  const state = await inspectLauncherState(config);
  assert.equal(state.cdpReady, false);
  assert.equal(state.profileOwned, false);
  assert.equal(state.profileOwnership, "unverified");
  assert.equal(state.launchable, true);
  assert.equal(state.blocker, null);
  assert.match(state.cdpError, /path does not match/);
});

test("a matching DevToolsActivePort endpoint is safely reused", async (t) => {
  const root = await temporaryRoot(t);
  const config = dedicatedConfig(root, {
    chromePath: path.join(root, "missing-chrome"),
  });
  await executable(config.mcpPath);

  const owned = await startCdpServer({ browser: "FixtureChrome/2.0" });
  t.after(owned.close);
  await writeActivePort(config, owned.port, owned.webSocketPath);

  const result = await ensureBrowser(config);
  assert.equal(result.reused, true);
  assert.equal(result.launched, false);
  assert.equal(result.cdpReady, true);
  assert.equal(result.cdpUrl, owned.baseUrl);
  assert.equal(result.cdpBrowser, "FixtureChrome/2.0");
  assert.equal(result.profileOwnership, "verified");
});

test("missing and malformed endpoint files can relaunch, but a locked profile blocks without deletion", async (t) => {
  const root = await temporaryRoot(t);
  const config = dedicatedConfig(root);
  await mkdir(config.profilePath, { recursive: true });
  await executable(config.chromePath);
  await executable(config.mcpPath);

  const missing = await inspectLauncherState(config);
  assert.equal(missing.activePortStatus, "missing");
  assert.equal(missing.launchable, true);

  await writeFile(config.devToolsActivePortPath, "partial", "utf8");
  const malformed = await inspectLauncherState(config);
  assert.equal(malformed.activePortStatus, "invalid");
  assert.equal(malformed.profileOwnership, "invalid");
  assert.equal(malformed.launchable, true);

  const lockPath = path.join(config.profilePath, "SingletonLock");
  await writeFile(lockPath, "fixture-lock", "utf8");
  const locked = await inspectLauncherState(config);
  assert.equal(locked.blocker, "CHROME_PROFILE_LOCKED");
  assert.equal(locked.profileLocked, true);
  assert.deepEqual(await findProfileLocks(config.profilePath), [lockPath]);
  await assert.rejects(
    ensureBrowser(config),
    (error) =>
      error instanceof LauncherError && error.code === "CHROME_PROFILE_LOCKED",
  );
  assert.equal(await readFile(lockPath, "utf8"), "fixture-lock");
});

test("explicit URL mode never launches Chrome", async (t) => {
  const root = await temporaryRoot(t);
  const launchMarker = path.join(root, "chrome-launched");
  const chromePath = path.join(root, "chrome");
  const mcpPath = path.join(root, "chrome-devtools-mcp");
  await executable(
    chromePath,
    `#!/bin/sh\nprintf launched > ${JSON.stringify(launchMarker)}\nexit 0\n`,
  );
  await executable(mcpPath);

  const external = await startCdpServer({ browser: "ExternalChrome/1.0" });
  t.after(external.close);
  const baseConfig = {
    ...dedicatedConfig(root),
    connectionMode: "external",
    cdpUrl: external.baseUrl,
    chromePath,
    mcpPath,
  };
  const reused = await ensureBrowser(baseConfig);
  assert.equal(reused.reused, true);
  assert.equal(reused.connectionMode, "external");
  assert.equal(reused.profileOwnership, "external");
  assert.equal(reused.chromeExists, null);
  assert.equal(await fileExists(launchMarker), false);

  const unavailablePort = await closedPort();
  await assert.rejects(
    ensureBrowser({
      ...baseConfig,
      cdpUrl: `http://127.0.0.1:${unavailablePort}`,
    }),
    (error) =>
      error instanceof LauncherError &&
      error.code === "EXTERNAL_CDP_UNAVAILABLE",
  );
  assert.equal(await fileExists(launchMarker), false);
});

test("spawned Chrome polls stale and partial endpoint state, then MCP receives the exact dynamic URL", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "controlmac-dynamic-launch-test-"),
  );
  const config = dedicatedConfig(root, {
    startupTimeoutMs: 3_000,
    pollIntervalMs: 15,
  });
  await mkdir(config.profilePath, { recursive: true });

  const pidPath = path.join(config.profilePath, "fixture.pid");
  const chromeArgsPath = path.join(config.profilePath, "chrome-args.json");
  const mcpArgsPath = path.join(root, "mcp-args.json");
  t.after(async () => {
    await stopFixtureProcess(pidPath);
    await rm(root, { recursive: true, force: true });
  });
  const dynamicPath = "/devtools/browser/dynamic-owned-endpoint";
  const fakeChrome = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const profileArgument = process.argv.find((value) => value.startsWith("--user-data-dir="));
if (!profileArgument || !process.argv.includes("--remote-debugging-port=0")) process.exit(41);
const profilePath = profileArgument.slice("--user-data-dir=".length);
const activePortPath = path.join(profilePath, "DevToolsActivePort");
await mkdir(profilePath, { recursive: true });
await writeFile(${JSON.stringify(pidPath)}, String(process.pid), "utf8");
await writeFile(${JSON.stringify(chromeArgsPath)}, JSON.stringify(process.argv.slice(2)), "utf8");

const webSocketPath = ${JSON.stringify(dynamicPath)};
const server = http.createServer((request, response) => {
  const address = server.address();
  response.setHeader("content-type", "application/json");
  if (request.url === "/json/version" && address && typeof address !== "string") {
    response.end(JSON.stringify({
      Browser: "FakeDynamicChrome/1.0",
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: \`ws://127.0.0.1:\${address.port}\${webSocketPath}\`,
    }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(42);
  await writeFile(activePortPath, String(address.port), "utf8");
  setTimeout(() => {
    writeFile(activePortPath, \`\${address.port}\\n\${webSocketPath}\\n\`, "utf8")
      .catch(() => process.exit(43));
  }, 100);
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
`;
  await executable(config.chromePath, fakeChrome);

  const fakeMcp = `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(mcpArgsPath)}, JSON.stringify(process.argv.slice(2)), "utf8");
`;
  await executable(config.mcpPath, fakeMcp);

  const stalePort = await closedPort();
  await writeActivePort(
    config,
    stalePort,
    "/devtools/browser/stale-endpoint",
  );
  const code = await main([], {
    CONTROLMAC_HOME: root,
    CONTROLMAC_CHROME_PATH: config.chromePath,
    CONTROLMAC_CHROME_USER_DATA_DIR: config.profilePath,
    CONTROLMAC_CHROME_MCP_PATH: config.mcpPath,
    CONTROLMAC_CHROME_MCP_LOG_PATH: config.logPath,
    CONTROLMAC_STARTUP_TIMEOUT_MS: String(config.startupTimeoutMs),
    CONTROLMAC_POLL_INTERVAL_MS: String(config.pollIntervalMs),
  });
  assert.equal(code, 0);

  const activePort = await readDevToolsActivePort(config.devToolsActivePortPath);
  assert.equal(activePort.status, "valid");
  assert.notEqual(activePort.port, stalePort);
  assert.equal(activePort.webSocketPath, dynamicPath);

  const chromeArguments = JSON.parse(await readFile(chromeArgsPath, "utf8"));
  assert.ok(chromeArguments.includes("--remote-debugging-port=0"));
  assert.ok(
    chromeArguments.includes(`--user-data-dir=${config.profilePath}`),
  );

  const mcpArguments = JSON.parse(await readFile(mcpArgsPath, "utf8"));
  assert.ok(mcpArguments.includes(`--browser-url=${activePort.cdpUrl}`));
  assert.equal(
    mcpArguments.filter((argument) => argument.startsWith("--browser-url=")).length,
    1,
  );
});

test("runMcp rejects an unresolved endpoint and uses the launcher's absolute Node", async (t) => {
  const root = await temporaryRoot(t, "controlmac-mcp-node-test-");
  const mcpPath = path.join(root, "fake-mcp.mjs");
  const cdpUrl = "http://127.0.0.1:9444";
  await executable(
    mcpPath,
    `const required = [${JSON.stringify(`--browser-url=${cdpUrl}`)}, "--experimental-vision", "--no-usage-statistics"];
process.exit(required.every((value) => process.argv.includes(value)) ? 0 : 7);\n`,
  );

  await assert.rejects(
    runMcp({
      cdpUrl: null,
      mcpPath,
      logPath: path.join(root, "logs", "mcp.log"),
    }),
    (error) =>
      error instanceof LauncherError && error.code === "CDP_URL_UNRESOLVED",
  );
  assert.equal(
    await runMcp({
      cdpUrl,
      mcpPath,
      logPath: path.join(root, "logs", "mcp.log"),
    }),
    0,
  );
});

test("launcher CLI rejects unknown options without touching the browser", async () => {
  await assert.rejects(
    main(["--not-a-real-option"], {}),
    (error) =>
      error instanceof LauncherError && error.code === "INVALID_ARGUMENT",
  );
});
