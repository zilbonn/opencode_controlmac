#!/usr/bin/env node

import { access, lstat, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);

const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const LEGACY_CDP_PREFIX = ["CONTROLMAC", "CDP"].join("_");
const LEGACY_CDP_HOST = `${LEGACY_CDP_PREFIX}_${"HOST"}`;
const LEGACY_CDP_PORT = `${LEGACY_CDP_PREFIX}_${"PORT"}`;

export class LauncherError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LauncherError";
    this.code = code;
    this.details = details;
  }
}

function expandHome(value, homeDirectory) {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return path.join(homeDirectory, value.slice(2));
  return value;
}

function absolutePath(value, homeDirectory) {
  return path.resolve(expandHome(value, homeDirectory));
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new LauncherError(
      "INVALID_CONFIGURATION",
      `${name} must be a positive integer`,
      { name, value },
    );
  }
  return parsed;
}

function normalizedBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LauncherError(
      "INVALID_CONFIGURATION",
      "CONTROLMAC_CDP_URL must be a valid HTTP(S) origin",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LauncherError(
      "INVALID_CONFIGURATION",
      "CONTROLMAC_CDP_URL must use http or https",
    );
  }
  if (url.username || url.password) {
    throw new LauncherError(
      "INVALID_CONFIGURATION",
      "CONTROLMAC_CDP_URL must not contain credentials",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new LauncherError(
      "INVALID_CONFIGURATION",
      "CONTROLMAC_CDP_URL must be an origin without a path, query, or fragment",
    );
  }
  return url.origin;
}

export function getLauncherConfig(env = process.env) {
  if (
    env[LEGACY_CDP_HOST] !== undefined ||
    env[LEGACY_CDP_PORT] !== undefined
  ) {
    throw new LauncherError(
      "INVALID_CONFIGURATION",
      `${LEGACY_CDP_HOST} and ${LEGACY_CDP_PORT} were removed; use CONTROLMAC_CDP_URL for connect-only mode`,
      {
        removedVariables: [LEGACY_CDP_HOST, LEGACY_CDP_PORT],
      },
    );
  }

  const homeDirectory = absolutePath(
    env.CONTROLMAC_HOME ?? env.HOME ?? os.homedir(),
    os.homedir(),
  );
  const profilePath = absolutePath(
    env.CONTROLMAC_CHROME_USER_DATA_DIR ??
      path.join(
        homeDirectory,
        "Library/Application Support/OpenCodeControl/chrome-beta",
      ),
    homeDirectory,
  );
  const cdpUrl = env.CONTROLMAC_CDP_URL
    ? normalizedBaseUrl(env.CONTROLMAC_CDP_URL)
    : null;

  return {
    connectionMode: cdpUrl ? "external" : "dedicated-profile",
    cdpUrl,
    chromePath: absolutePath(
      env.CONTROLMAC_CHROME_PATH ?? DEFAULT_CHROME_PATH,
      homeDirectory,
    ),
    profilePath,
    devToolsActivePortPath: path.join(profilePath, "DevToolsActivePort"),
    mcpPath: absolutePath(
      env.CONTROLMAC_CHROME_MCP_PATH ??
        path.join(REPO_ROOT, "node_modules/.bin/chrome-devtools-mcp"),
      homeDirectory,
    ),
    logPath: absolutePath(
      env.CONTROLMAC_CHROME_MCP_LOG_PATH ??
        env.CONTROLMAC_LOG_PATH ??
        path.join(
          homeDirectory,
          "Library/Logs/OpenCodeControl/chrome-devtools.log",
        ),
      homeDirectory,
    ),
    startupTimeoutMs: positiveInteger(
      env.CONTROLMAC_STARTUP_TIMEOUT_MS,
      "CONTROLMAC_STARTUP_TIMEOUT_MS",
      DEFAULT_STARTUP_TIMEOUT_MS,
    ),
    pollIntervalMs: positiveInteger(
      env.CONTROLMAC_POLL_INTERVAL_MS,
      "CONTROLMAC_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
    ),
  };
}

async function exists(filePath, mode) {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

function versionEndpoint(cdpUrl) {
  return `${cdpUrl.replace(/\/$/, "")}/json/version`;
}

function isLoopback(host) {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function urlPort(url) {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:" || url.protocol === "wss:") return 443;
  return 80;
}

export async function probeCdp(
  cdpUrl,
  timeoutMs = 1_000,
  expectedOwnership = null,
) {
  try {
    const response = await fetch(versionEndpoint(cdpUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.webSocketDebuggerUrl !== "string"
    ) {
      return { ok: false, error: "response is not a Chrome DevTools endpoint" };
    }

    let webSocketUrl;
    try {
      webSocketUrl = new URL(data.webSocketDebuggerUrl);
    } catch {
      return { ok: false, error: "response contains an invalid WebSocket URL" };
    }
    if (webSocketUrl.protocol !== "ws:" && webSocketUrl.protocol !== "wss:") {
      return { ok: false, error: "response contains an invalid WebSocket URL" };
    }

    if (expectedOwnership) {
      if (!isLoopback(webSocketUrl.hostname)) {
        return {
          ok: false,
          error: `DevTools WebSocket host is not loopback: ${webSocketUrl.hostname}`,
        };
      }
      if (urlPort(webSocketUrl) !== expectedOwnership.port) {
        return {
          ok: false,
          error: `DevTools WebSocket port does not match DevToolsActivePort: ${urlPort(webSocketUrl)} != ${expectedOwnership.port}`,
        };
      }
      if (
        webSocketUrl.pathname !== expectedOwnership.webSocketPath ||
        webSocketUrl.search !== "" ||
        webSocketUrl.hash !== ""
      ) {
        return {
          ok: false,
          error: `DevTools WebSocket path does not match DevToolsActivePort: ${webSocketUrl.pathname}${webSocketUrl.search}${webSocketUrl.hash}`,
        };
      }
    }

    return {
      ok: true,
      browser: typeof data.Browser === "string" ? data.Browser : "unknown",
      protocolVersion:
        typeof data["Protocol-Version"] === "string"
          ? data["Protocol-Version"]
          : "unknown",
      webSocketDebuggerUrl: webSocketUrl.toString(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readDevToolsActivePort(activePortPath) {
  let contents;
  try {
    contents = await readFile(activePortPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        status: "missing",
        path: activePortPath,
        port: null,
        webSocketPath: null,
        cdpUrl: null,
        error: "DevToolsActivePort is missing",
      };
    }
    return {
      status: "unreadable",
      path: activePortPath,
      port: null,
      webSocketPath: null,
      cdpUrl: null,
      error: `DevToolsActivePort cannot be read: ${error.message}`,
    };
  }

  const lines = contents.trimEnd().split(/\r?\n/);
  if (lines.length !== 2) {
    return {
      status: "invalid",
      path: activePortPath,
      port: null,
      webSocketPath: null,
      cdpUrl: null,
      error: "DevToolsActivePort must contain exactly two lines",
    };
  }

  const portText = lines[0];
  const port = Number(portText);
  const webSocketPath = lines[1];
  if (
    !/^\d{1,5}$/.test(portText) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return {
      status: "invalid",
      path: activePortPath,
      port: null,
      webSocketPath: null,
      cdpUrl: null,
      error: "DevToolsActivePort contains an invalid port",
    };
  }
  if (!/^\/devtools\/browser\/[^/?#\s]+$/.test(webSocketPath)) {
    return {
      status: "invalid",
      path: activePortPath,
      port,
      webSocketPath: null,
      cdpUrl: null,
      error:
        "DevToolsActivePort contains an invalid relative browser WebSocket path",
    };
  }

  return {
    status: "valid",
    path: activePortPath,
    port,
    webSocketPath,
    cdpUrl: `http://127.0.0.1:${port}`,
    error: null,
  };
}

export async function findProfileLocks(profilePath) {
  const lockNames = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  const found = [];
  for (const name of lockNames) {
    const candidate = path.join(profilePath, name);
    try {
      await lstat(candidate);
      found.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return found;
}

function profileOwnership(activePort, cdpReady, connectionMode) {
  if (connectionMode === "external") return "external";
  if (cdpReady) return "verified";
  if (activePort.status === "missing") return "missing";
  if (activePort.status === "invalid") return "invalid";
  return "unverified";
}

export async function inspectLauncherState(config = getLauncherConfig()) {
  const mcpExists = await exists(config.mcpPath, 1);

  if (config.connectionMode === "external") {
    const cdp = await probeCdp(config.cdpUrl);
    const blocker = !mcpExists
      ? "MCP_EXECUTABLE_MISSING"
      : cdp.ok
        ? null
        : "EXTERNAL_CDP_UNAVAILABLE";
    return {
      connectionMode: "external",
      cdpReady: cdp.ok,
      cdpUrl: config.cdpUrl,
      cdpBrowser: cdp.ok ? cdp.browser : null,
      cdpProtocolVersion: cdp.ok ? cdp.protocolVersion : null,
      cdpError: cdp.ok ? null : cdp.error,
      profileOwnership: "external",
      profileOwned: false,
      devToolsActivePortPath: config.devToolsActivePortPath,
      activePortStatus: "not-used",
      activePortPort: null,
      activePortWebSocketPath: null,
      chromeExists: null,
      mcpExists,
      profileLocked: false,
      profileLocks: [],
      launchable: false,
      blocker,
    };
  }

  const [chromeExists, profileLocks, activePort] = await Promise.all([
    exists(config.chromePath, 1),
    findProfileLocks(config.profilePath),
    readDevToolsActivePort(config.devToolsActivePortPath),
  ]);
  const cdp =
    activePort.status === "valid"
      ? await probeCdp(activePort.cdpUrl, 1_000, {
          port: activePort.port,
          webSocketPath: activePort.webSocketPath,
        })
      : { ok: false, error: activePort.error };

  let blocker = null;
  if (!mcpExists) blocker = "MCP_EXECUTABLE_MISSING";
  else if (cdp.ok) blocker = null;
  else if (activePort.status === "unreadable") {
    blocker = "DEVTOOLS_ACTIVE_PORT_UNREADABLE";
  } else if (!chromeExists) blocker = "CHROME_NOT_FOUND";
  else if (profileLocks.length > 0) blocker = "CHROME_PROFILE_LOCKED";

  return {
    connectionMode: "dedicated-profile",
    cdpReady: cdp.ok,
    cdpUrl: activePort.cdpUrl,
    cdpBrowser: cdp.ok ? cdp.browser : null,
    cdpProtocolVersion: cdp.ok ? cdp.protocolVersion : null,
    cdpError: cdp.ok ? null : cdp.error,
    profileOwnership: profileOwnership(
      activePort,
      cdp.ok,
      "dedicated-profile",
    ),
    profileOwned: cdp.ok,
    devToolsActivePortPath: config.devToolsActivePortPath,
    activePortStatus: activePort.status,
    activePortPort: activePort.port,
    activePortWebSocketPath: activePort.webSocketPath,
    chromeExists,
    mcpExists,
    profileLocked: profileLocks.length > 0,
    profileLocks,
    launchable: !cdp.ok && blocker === null,
    blocker,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateSpawnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 1_000)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 1_000);
}

async function waitForSpawn(child) {
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function blockerToError(state, config) {
  switch (state.blocker) {
    case "MCP_EXECUTABLE_MISSING":
      return new LauncherError(
        state.blocker,
        `Chrome DevTools MCP executable was not found: ${config.mcpPath}`,
      );
    case "EXTERNAL_CDP_UNAVAILABLE":
      return new LauncherError(
        state.blocker,
        `The explicit CDP endpoint is unavailable; connect-only mode never launches Chrome: ${config.cdpUrl}`,
        { cdpUrl: config.cdpUrl, cdpError: state.cdpError },
      );
    case "DEVTOOLS_ACTIVE_PORT_UNREADABLE":
      return new LauncherError(
        state.blocker,
        `The dedicated profile endpoint file cannot be read: ${config.devToolsActivePortPath}`,
        { cdpError: state.cdpError },
      );
    case "CHROME_NOT_FOUND":
      return new LauncherError(
        state.blocker,
        `Google Chrome Beta was not found or is not executable: ${config.chromePath}`,
      );
    case "CHROME_PROFILE_LOCKED":
      return new LauncherError(
        state.blocker,
        "The dedicated Chrome Beta profile is locked but its owned CDP endpoint cannot be verified",
        {
          profilePath: config.profilePath,
          lockFiles: state.profileLocks,
          cdpError: state.cdpError,
        },
      );
    default:
      return new LauncherError(
        "BROWSER_UNAVAILABLE",
        "Chrome Beta cannot be started for the dedicated ControlMac profile",
      );
  }
}

async function inspectSpawnedEndpoint(config) {
  const activePort = await readDevToolsActivePort(config.devToolsActivePortPath);
  if (activePort.status !== "valid") {
    return { activePort, cdp: { ok: false, error: activePort.error } };
  }
  const cdp = await probeCdp(activePort.cdpUrl, 1_000, {
    port: activePort.port,
    webSocketPath: activePort.webSocketPath,
  });
  return { activePort, cdp };
}

export async function ensureBrowser(config = getLauncherConfig()) {
  const state = await inspectLauncherState(config);
  if (state.cdpReady) {
    return { launched: false, reused: true, ...state };
  }
  if (config.connectionMode === "external" || !state.launchable) {
    throw blockerToError(state, config);
  }

  await mkdir(config.profilePath, { recursive: true });
  const chromeArguments = [
    "--remote-debugging-port=0",
    `--user-data-dir=${config.profilePath}`,
    "--force-renderer-accessibility",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const chrome = spawn(config.chromePath, chromeArguments, {
    detached: true,
    stdio: "ignore",
  });
  await waitForSpawn(chrome).catch((error) => {
    throw new LauncherError(
      "CHROME_LAUNCH_FAILED",
      `Failed to start Google Chrome Beta: ${error.message}`,
    );
  });

  let exitState = null;
  chrome.once("exit", (code, signal) => {
    exitState = { code, signal };
  });
  chrome.unref();

  const deadline = Date.now() + config.startupTimeoutMs;
  let lastEndpoint = {
    activePort: {
      status: "missing",
      path: config.devToolsActivePortPath,
      port: null,
      webSocketPath: null,
      cdpUrl: null,
      error: "not inspected",
    },
    cdp: { ok: false, error: "not probed" },
  };
  while (Date.now() < deadline) {
    lastEndpoint = await inspectSpawnedEndpoint(config);
    if (lastEndpoint.cdp.ok) {
      const profileLocks = await findProfileLocks(config.profilePath);
      return {
        launched: true,
        reused: false,
        connectionMode: "dedicated-profile",
        cdpReady: true,
        cdpUrl: lastEndpoint.activePort.cdpUrl,
        cdpBrowser: lastEndpoint.cdp.browser,
        cdpProtocolVersion: lastEndpoint.cdp.protocolVersion,
        cdpError: null,
        profileOwnership: "verified",
        profileOwned: true,
        devToolsActivePortPath: config.devToolsActivePortPath,
        activePortStatus: "valid",
        activePortPort: lastEndpoint.activePort.port,
        activePortWebSocketPath: lastEndpoint.activePort.webSocketPath,
        chromeExists: true,
        mcpExists: true,
        profileLocked: profileLocks.length > 0,
        profileLocks,
        launchable: false,
        blocker: null,
      };
    }
    if (exitState) {
      throw new LauncherError(
        "CHROME_EXITED",
        "Google Chrome Beta exited before its profile-owned DevTools endpoint became ready",
        {
          ...exitState,
          activePortStatus: lastEndpoint.activePort.status,
          lastError: lastEndpoint.cdp.error,
        },
      );
    }
    await delay(
      Math.min(config.pollIntervalMs, Math.max(1, deadline - Date.now())),
    );
  }

  // Only terminate the child from this launch attempt. Never delete Chrome's
  // Singleton* files or DevToolsActivePort, and never signal a reused browser.
  if (!exitState) await terminateSpawnedChild(chrome);
  throw new LauncherError(
    "CHROME_STARTUP_TIMEOUT",
    `Chrome Beta did not expose a profile-owned CDP endpoint within ${config.startupTimeoutMs}ms`,
    {
      devToolsActivePortPath: config.devToolsActivePortPath,
      activePortStatus: lastEndpoint.activePort.status,
      cdpUrl: lastEndpoint.activePort.cdpUrl,
      lastError: lastEndpoint.cdp.error,
    },
  );
}

export async function runMcp(config = getLauncherConfig()) {
  if (!config.cdpUrl) {
    throw new LauncherError(
      "CDP_URL_UNRESOLVED",
      "A verified CDP URL is required before Chrome DevTools MCP can start",
    );
  }
  await mkdir(path.dirname(config.logPath), { recursive: true });
  const argumentsForMcp = [
    `--browser-url=${config.cdpUrl}`,
    "--experimental-vision",
    "--no-category-performance",
    "--no-category-network",
    "--no-category-emulation",
    "--allow-unrestricted-paths",
    "--no-usage-statistics",
    `--log-file=${config.logPath}`,
  ];
  // The .bin shim uses `#!/usr/bin/env node`, which is unreliable for GUI apps
  // with a reduced PATH. Reuse the absolute Node executable that launched us.
  const mcp = spawn(process.execPath, [config.mcpPath, ...argumentsForMcp], {
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    let forceTimer = null;
    const forwardSignal = (signal) => {
      if (mcp.exitCode !== null || mcp.signalCode !== null) return;
      mcp.kill(signal);
      forceTimer = setTimeout(() => {
        if (mcp.exitCode === null && mcp.signalCode === null) mcp.kill("SIGKILL");
      }, 2_000);
      forceTimer.unref();
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = new Map(
      signals.map((signal) => [signal, () => forwardSignal(signal)]),
    );
    const cleanup = () => {
      if (forceTimer) clearTimeout(forceTimer);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };
    for (const [signal, handler] of signalHandlers) process.once(signal, handler);

    mcp.once("error", (error) => {
      cleanup();
      reject(
        new LauncherError(
          "MCP_START_FAILED",
          `Failed to start Chrome DevTools MCP: ${error.message}`,
        ),
      );
    });
    mcp.once("exit", (code, signal) => {
      cleanup();
      resolve(signal ? 128 : (code ?? 1));
    });
  });
}

function publicCheck(config, state) {
  return {
    ok: state.mcpExists && (state.cdpReady || state.launchable),
    connectionMode: state.connectionMode,
    profileOwnership: state.profileOwnership,
    resolvedCdpUrl: state.cdpUrl,
    cdpReady: state.cdpReady,
    cdpBrowser: state.cdpBrowser,
    cdpError: state.cdpError,
    chromePath: config.chromePath,
    chromeExists: state.chromeExists,
    profilePath: config.profilePath,
    devToolsActivePortPath: config.devToolsActivePortPath,
    activePortStatus: state.activePortStatus,
    activePortPort: state.activePortPort,
    activePortWebSocketPath: state.activePortWebSocketPath,
    profileLocked: state.profileLocked,
    mcpPath: config.mcpPath,
    mcpExists: state.mcpExists,
    launchable: state.launchable,
    blocker: state.blocker,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const allowed = new Set(["--check", "--ensure-browser"]);
  const unknown = argv.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0 || argv.length > 1) {
    throw new LauncherError(
      "INVALID_ARGUMENT",
      "Usage: chrome-beta-mcp.mjs [--check | --ensure-browser]",
      { unknown },
    );
  }

  const config = getLauncherConfig(env);
  if (argv[0] === "--check") {
    const state = await inspectLauncherState(config);
    const result = publicCheck(config, state);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  const browser = await ensureBrowser(config);
  if (argv[0] === "--ensure-browser") {
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...browser }, null, 2)}\n`,
    );
    return 0;
  }

  process.stderr.write(
    `[controlmac-browser] ${browser.reused ? "reusing" : "started"} Chrome Beta at ${browser.cdpUrl} (${browser.profileOwnership})\n`,
  );
  return runMcp({ ...config, cdpUrl: browser.cdpUrl });
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const code =
        error instanceof LauncherError ? error.code : "UNEXPECTED_ERROR";
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[controlmac-browser] ${code}: ${message}\n`);
      if (
        error instanceof LauncherError &&
        Object.keys(error.details).length > 0
      ) {
        process.stderr.write(`${JSON.stringify(error.details)}\n`);
      }
      process.exitCode = 1;
    });
}
