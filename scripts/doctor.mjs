#!/usr/bin/env node

import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "jsonc-parser";
import semver from "semver";
import {
  getLauncherConfig,
  inspectLauncherState,
} from "./chrome-beta-mcp.mjs";
import { desiredMcpEntries, getInstallPaths } from "./install.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const PROJECT_PACKAGE = JSON.parse(
  await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
);
const SUPPORTED_NODE_RANGE = PROJECT_PACKAGE.engines?.node;
if (typeof SUPPORTED_NODE_RANGE !== "string" || !semver.validRange(SUPPORTED_NODE_RANGE)) {
  throw new Error("package.json must declare a valid engines.node range");
}
const PINNED_OPENCODE_VERSION = "1.18.21";
const PINNED_PEEKABOO_VERSION = "4.2.2";
const PEEKABOO_APP_PLIST = "/Applications/Peekaboo.app/Contents/Info.plist";
const LOG_SHARING_WARNING =
  "WARNING: Log excerpts are local debugging data. Review and redact them again before sharing.";

export function classifyNodeVersion(version) {
  const normalized = semver.valid(version);
  if (!normalized) {
    return {
      status: "error",
      detail: `${version || "unknown"} is not a valid Node version`,
    };
  }
  return {
    status: semver.satisfies(normalized, SUPPORTED_NODE_RANGE) ? "ok" : "error",
    detail: `${version} (requires ${SUPPORTED_NODE_RANGE})`,
  };
}

export function classifyOpenCodeVersion(output) {
  const match = String(output ?? "").match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  const version = match ? semver.valid(match[1]) : null;
  if (!version) {
    return {
      status: "error",
      version: null,
      detail: "could not parse a semantic version from opencode --version",
    };
  }
  if (semver.major(version) >= 2) {
    return {
      status: "error",
      version,
      detail: `${version} is unsupported; requires OpenCode 1.x at or above ${PINNED_OPENCODE_VERSION}`,
    };
  }
  if (semver.lt(version, PINNED_OPENCODE_VERSION)) {
    return {
      status: "error",
      version,
      detail: `${version} is too old; requires at least ${PINNED_OPENCODE_VERSION}`,
    };
  }
  return {
    status: version === PINNED_OPENCODE_VERSION ? "ok" : "warn",
    version,
    detail:
      version === PINNED_OPENCODE_VERSION
        ? version
        : `${version} is compatible but untested (validated version: ${PINNED_OPENCODE_VERSION})`,
  };
}

function parseArguments(argv) {
  const supported = new Set(["--json", "--logs"]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length > 0) {
    throw new Error("Usage: doctor.mjs [--json] [--logs]");
  }
  return { json: argv.includes("--json"), logs: argv.includes("--logs") };
}

async function exists(filePath, mode = fsConstants.F_OK) {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(name, env = process.env) {
  if (name.includes(path.sep)) {
    return (await exists(name, fsConstants.X_OK)) ? name : null;
  }
  const candidates = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name));
  for (const candidate of candidates) {
    if (await exists(candidate, fsConstants.X_OK)) return candidate;
  }
  return null;
}

async function run(executable, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({
          ok: false,
          code: child.exitCode,
          signal: child.signalCode,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut: true,
          error: `Process did not exit within ${timeoutMs + 1_000}ms`,
        });
      }, 1_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 256_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 256_000) stderr += chunk;
    });
    child.once("error", (error) => {
      finish({ ok: false, code: null, stdout, stderr, error: error.message, timedOut });
    });
    child.once("exit", (code, signal) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}

async function packageVersion(name) {
  const packagePath = path.join(REPO_ROOT, "node_modules", name, "package.json");
  try {
    const data = JSON.parse(await readFile(packagePath, "utf8"));
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

async function inspectPeekabooAppVersion() {
  if (!(await exists(PEEKABOO_APP_PLIST))) {
    return { ok: false, version: null, error: "Peekaboo.app is not installed in /Applications" };
  }
  const result = await run(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", PEEKABOO_APP_PLIST],
    5_000,
  );
  if (!result.ok) {
    return {
      ok: false,
      version: null,
      error: result.timedOut
        ? "Peekaboo.app version check timed out"
        : result.stderr || result.error || `PlistBuddy exited ${result.code}`,
    };
  }
  const version = result.stdout.trim();
  return version
    ? { ok: true, version }
    : { ok: false, version: null, error: "Peekaboo.app has no bundle version" };
}

async function inspectPermissions(peekabooPath, runtimeArguments) {
  if (!(await exists(peekabooPath, fsConstants.X_OK))) {
    return { ok: false, error: "Peekaboo executable is missing", permissions: [] };
  }
  const result = await run(
    peekabooPath,
    ["permissions", "status", ...runtimeArguments, "--json"],
    8_000,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.timedOut
        ? "Permission check timed out"
        : result.stderr || result.error || `Exited ${result.code}`,
      permissions: [],
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed?.success !== true) {
      throw new Error(parsed?.error?.message ?? "permission command reported failure");
    }
    const permissions = parsed?.data?.permissions;
    if (!Array.isArray(permissions)) throw new Error("permissions array missing");
    return {
      ok: true,
      source: parsed?.data?.source ?? "unknown",
      permissions: permissions.map((permission) => ({
        name: permission.name,
        granted: permission.isGranted === true,
        requiredByPeekaboo: permission.isRequired === true,
        instructions: permission.grantInstructions,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Could not parse Peekaboo permission output: ${error.message}`,
      permissions: [],
    };
  }
}

async function inspectStableChromeRemoteDebugging(paths) {
  if (!(await exists(paths.chromeMcpPath, fsConstants.X_OK))) {
    return {
      ok: false,
      ready: false,
      error: "Chrome DevTools MCP executable is missing",
    };
  }
  if (!(await exists(paths.stableChromeDevToolsActivePortPath))) {
    return {
      ok: true,
      ready: false,
      detail: "Chrome stable is not running with remote debugging enabled",
    };
  }
  try {
    const [portLine] = (await readFile(paths.stableChromeDevToolsActivePortPath, "utf8"))
      .trim()
      .split(/\r?\n/);
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error("DevToolsActivePort contains an invalid port");
    }
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`DevTools endpoint returned HTTP ${response.status}`);
    const version = await response.json();
    if (!version || typeof version.webSocketDebuggerUrl !== "string") {
      throw new Error("DevTools endpoint returned no browser WebSocket URL");
    }
    return {
      ok: true,
      ready: true,
      port,
      browser: version.Browser ?? "Chrome stable",
    };
  } catch (error) {
    return {
      ok: true,
      ready: false,
      detail: `remote debugging endpoint is unavailable: ${error.message}`,
    };
  }
}

async function inspectOpenCodeConfig(configPath, expectedEntries) {
  if (!(await exists(configPath))) {
    return {
      exists: false,
      valid: false,
      error: "OpenCode config does not exist",
      mcp: {},
    };
  }
  try {
    const text = await readFile(configPath, "utf8");
    const errors = [];
    const data = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !data || typeof data !== "object") {
      return {
        exists: true,
        valid: false,
        error: "OpenCode config is not valid JSONC",
        mcp: {},
      };
    }
    const mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : {};
    const inspectEntry = (name) => {
      const candidate = mcp[name];
      const configured = Object.hasOwn(mcp, name);
      const objectEntry =
        configured && candidate && typeof candidate === "object" && !Array.isArray(candidate);
      return {
        configured,
        enabled: objectEntry && candidate.enabled !== false,
        matchesExpected: objectEntry && isDeepStrictEqual(candidate, expectedEntries[name]),
      };
    };
    return {
      exists: true,
      valid: true,
      mcp: {
        "controlmac-native": inspectEntry("controlmac-native"),
        "controlmac-capture": inspectEntry("controlmac-capture"),
        "controlmac-browser": inspectEntry("controlmac-browser"),
        "controlmac-stable-browser": inspectEntry("controlmac-stable-browser"),
      },
      otherMcpNames: Object.keys(mcp).filter(
        (name) =>
          name !== "controlmac-native" &&
          name !== "controlmac-capture" &&
          name !== "controlmac-browser" &&
          name !== "controlmac-stable-browser",
      ),
    };
  } catch (error) {
    return { exists: true, valid: false, error: error.message, mcp: {} };
  }
}

async function inspectSymlink(target, expectedSource) {
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isSymbolicLink()) {
      return { ok: false, target, error: "target is not a symlink" };
    }
    const { readlink } = await import("node:fs/promises");
    const linkValue = await readlink(target);
    const resolved = path.resolve(path.dirname(target), linkValue);
    return {
      ok: resolved === path.resolve(expectedSource),
      target,
      source: resolved,
      expectedSource,
    };
  } catch (error) {
    return { ok: false, target, error: error.code === "ENOENT" ? "missing" : error.message };
  }
}

const JSON_SECRET_FIELD =
  /("(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|apikey|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|pwd)"\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)/gi;
const QUERY_SECRET_FIELD =
  /([?&](?:authorization|auth|cookie|x[-_]?api[-_]?key|api[-_]?key|apikey|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|token|key|secret|password|passwd|pass|pwd)=)[^&#\s"']*/gi;
const SIMPLE_SECRET_FIELD =
  /(\b(?:x[-_]?api[-_]?key|api[-_ ]?key|apikey|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi;

export function sanitizeLogLine(line) {
  return String(line)
    .replace(JSON_SECRET_FIELD, '$1"<redacted>"')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1<redacted>@")
    .replace(QUERY_SECRET_FIELD, "$1<redacted>")
    .replace(
      /(\b(?:proxy[-_ ]?)?authorization\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|.+)$/gi,
      "$1<redacted>",
    )
    .replace(
      /(\b(?:set[-_ ]?cookie|cookie)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|.+)$/gi,
      "$1<redacted>",
    )
    .replace(SIMPLE_SECRET_FIELD, "$1<redacted>");
}

async function collectLogFile(filePath, includeLines) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return null;
    const result = {
      path: filePath,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
    if (includeLines) {
      const text = await readFile(filePath, "utf8");
      result.tail = text
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-20)
        .map(sanitizeLogLine);
    }
    return result;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { path: filePath, error: error.message };
  }
}

async function logCandidates(homeDirectory, explicitChromeLog) {
  const candidates = new Set([
    explicitChromeLog,
    path.join(homeDirectory, "Library/Logs/Peekaboo/peekaboo.log"),
    path.join(homeDirectory, "Library/Logs/Peekaboo.log"),
  ]);
  for (const directory of [
    path.join(homeDirectory, "Library/Logs/OpenCodeControl"),
    path.join(homeDirectory, "Library/Logs/Peekaboo"),
  ]) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".log")) {
          candidates.add(path.join(directory, entry.name));
        }
      }
    } catch {
      // A missing optional log directory is normal before first use.
    }
  }
  return [...candidates];
}

function addCheck(checks, status, name, detail) {
  checks.push({ status, name, detail });
}

export function renderHumanReport(report, includeLogs = false) {
  let output = "OpenCode ControlMac doctor\n";
  if (includeLogs) output += `${LOG_SHARING_WARNING}\n`;
  for (const check of report.checks) {
    output += `[${check.status}] ${check.name}: ${check.detail}\n`;
  }
  if (report.logs.length > 0) {
    output += "Logs:\n";
    for (const log of report.logs) {
      output += `- ${log.path} (${log.size ?? "unknown"} bytes)\n`;
      if (includeLogs && log.tail) {
        for (const line of log.tail) output += `  ${line}\n`;
      }
    }
  }
  output += `Result: ${report.ok ? "ready" : "action required"}\n`;
  return output;
}

function printHuman(report, includeLogs) {
  process.stdout.write(renderHumanReport(report, includeLogs));
}

export async function diagnose(options = {}, env = process.env) {
  const installPaths = getInstallPaths({}, env);
  const expectedMcpEntries = desiredMcpEntries(installPaths, process.execPath);
  const launcherConfig = getLauncherConfig(env);
  const opencodePath = await resolveExecutable("opencode", env);
  const opencodeVersionPromise = opencodePath
    ? run(opencodePath, ["--version"], 5_000)
    : Promise.resolve(null);

  const [
    peekabooVersion,
    peekabooApp,
    chromeMcpVersion,
    sdkVersion,
    jsoncVersion,
    pluginVersion,
    nativePermissions,
    capturePermissions,
    config,
    skillLink,
    toolLink,
    chrome,
    stableBrowser,
    opencodeVersionResult,
  ] = await Promise.all([
    packageVersion("@steipete/peekaboo"),
    inspectPeekabooAppVersion(),
    packageVersion("chrome-devtools-mcp"),
    packageVersion("@modelcontextprotocol/sdk"),
    packageVersion("jsonc-parser"),
    packageVersion("@opencode-ai/plugin"),
    inspectPermissions(installPaths.peekabooPath, ["--no-remote"]),
    inspectPermissions(installPaths.peekabooPath, [
      "--bridge-socket",
      installPaths.peekabooBridgeSocket,
    ]),
    inspectOpenCodeConfig(installPaths.configPath, expectedMcpEntries),
    inspectSymlink(installPaths.skillTarget, installPaths.skillSource),
    inspectSymlink(installPaths.toolTarget, installPaths.toolSource),
    inspectLauncherState(launcherConfig),
    inspectStableChromeRemoteDebugging(installPaths),
    opencodeVersionPromise,
  ]);

  const checks = [];
  const nodeVersion = classifyNodeVersion(process.version);
  addCheck(checks, nodeVersion.status, "Node", nodeVersion.detail);
  for (const [name, actual, expected] of [
    ["Peekaboo CLI", peekabooVersion, PINNED_PEEKABOO_VERSION],
    ["Chrome DevTools MCP", chromeMcpVersion, "1.7.0"],
    ["MCP SDK", sdkVersion, "1.30.0"],
    ["jsonc-parser", jsoncVersion, "3.3.1"],
    ["OpenCode plugin SDK", pluginVersion, "1.18.21"],
  ]) {
    addCheck(
      checks,
      actual === expected ? "ok" : "error",
      name,
      actual ? `${actual} (expected ${expected})` : "not installed",
    );
  }
  addCheck(
    checks,
    peekabooApp.ok && peekabooApp.version === PINNED_PEEKABOO_VERSION ? "ok" : "error",
    "Peekaboo app",
    peekabooApp.ok
      ? `${peekabooApp.version} (expected ${PINNED_PEEKABOO_VERSION})`
      : peekabooApp.error,
  );
  addCheck(
    checks,
    opencodePath ? "ok" : "error",
    "OpenCode executable",
    opencodePath ?? "not found on PATH",
  );
  if (opencodeVersionResult) {
    if (!opencodeVersionResult.ok) {
      addCheck(
        checks,
        "error",
        "OpenCode CLI version",
        opencodeVersionResult.timedOut
          ? "opencode --version timed out"
          : opencodeVersionResult.stderr ||
              opencodeVersionResult.error ||
              `opencode --version exited ${opencodeVersionResult.code}`,
      );
    } else {
      const classification = classifyOpenCodeVersion(
        opencodeVersionResult.stdout || opencodeVersionResult.stderr,
      );
      addCheck(
        checks,
        classification.status,
        "OpenCode CLI version",
        classification.detail,
      );
    }
  }

  if (!nativePermissions.ok) {
    addCheck(checks, "error", "Native permissions", nativePermissions.error);
  } else {
    addCheck(
      checks,
      nativePermissions.source === "local" ? "ok" : "error",
      "Native runtime",
      nativePermissions.source === "local"
        ? "local semantic-action host"
        : `unexpected source: ${nativePermissions.source}`,
    );
    for (const name of ["Accessibility", "Event Synthesizing"]) {
      const permission = nativePermissions.permissions.find((candidate) => candidate.name === name);
      addCheck(
        checks,
        permission?.granted ? "ok" : "error",
        `Native ${name}`,
        permission?.granted ? "granted" : permission?.instructions ?? "not reported",
      );
    }
  }

  if (!capturePermissions.ok) {
    addCheck(checks, "error", "Capture permissions", capturePermissions.error);
  } else {
    addCheck(
      checks,
      capturePermissions.source === "bridge" ? "ok" : "error",
      "Capture runtime",
      capturePermissions.source === "bridge"
        ? "permission-aware app bridge"
        : `unexpected source: ${capturePermissions.source}`,
    );
    for (const name of ["Screen Recording", "Accessibility"]) {
      const permission = capturePermissions.permissions.find((candidate) => candidate.name === name);
      addCheck(
        checks,
        permission?.granted ? "ok" : "error",
        `Capture ${name}`,
        permission?.granted ? "granted" : permission?.instructions ?? "not reported",
      );
    }
  }

  addCheck(
    checks,
    config.valid ? "ok" : "error",
    "OpenCode config",
    config.valid ? installPaths.configPath : config.error,
  );
  for (const name of [
    "controlmac-native",
    "controlmac-capture",
    "controlmac-browser",
    "controlmac-stable-browser",
  ]) {
    const entry = config.mcp[name];
    addCheck(
      checks,
      entry?.configured && entry?.enabled && entry?.matchesExpected ? "ok" : "error",
      `MCP ${name}`,
      !entry?.configured
        ? "not configured"
        : !entry.enabled
          ? "disabled or invalid"
          : entry.matchesExpected
            ? "configured and enabled"
            : "does not match the pinned local command",
    );
  }
  addCheck(
    checks,
    skillLink.ok ? "ok" : "error",
    "Control skill link",
    skillLink.ok ? skillLink.target : skillLink.error ?? `points to ${skillLink.source}`,
  );
  addCheck(
    checks,
    toolLink.ok ? "ok" : "error",
    "Control tools link",
    toolLink.ok ? toolLink.target : toolLink.error ?? `points to ${toolLink.source}`,
  );

  const chromeConnectionMode =
    chrome.connectionMode ?? launcherConfig.connectionMode ?? "dedicated-profile";
  const chromeProfileOwnership = chrome.profileOwnership ?? "unknown";
  const chromeCdpUrl = chrome.cdpUrl ?? launcherConfig.cdpUrl ?? null;
  const chromeContext = [
    `mode=${chromeConnectionMode}`,
    `profile=${chromeProfileOwnership}`,
    `endpoint=${chromeCdpUrl ?? "unresolved"}`,
  ].join(", ");

  if (!chrome.mcpExists) {
    addCheck(checks, "error", "Chrome CDP", "Chrome DevTools MCP executable is missing");
  } else if (chrome.cdpReady) {
    addCheck(checks, "ok", "Chrome CDP", `${chrome.cdpBrowser}; ${chromeContext}`);
  } else if (chrome.launchable) {
    addCheck(
      checks,
      "warn",
      "Chrome CDP",
      `offline; launcher preflight passed (${chromeContext})`,
    );
  } else {
    addCheck(
      checks,
      "error",
      "Chrome CDP",
      `${chrome.blocker ?? "unavailable"}: ${chrome.cdpError ?? "endpoint unavailable"} (${chromeContext})`,
    );
  }

  addCheck(
    checks,
    stableBrowser.ready ? "ok" : "warn",
    "Chrome stable remote debugging",
    stableBrowser.ready
      ? `${stableBrowser.browser} endpoint is reachable for auto-connect at 127.0.0.1:${stableBrowser.port}; run list_pages to verify the intended profile`
      : stableBrowser.ok
        ? `${stableBrowser.detail}; enable chrome://inspect/#remote-debugging, restart OpenCode, then verify with list_pages`
        : stableBrowser.error,
  );

  const logs = (
    await Promise.all(
      (await logCandidates(installPaths.homeDirectory, launcherConfig.logPath)).map(
        (candidate) => collectLogFile(candidate, options.logs === true),
      ),
    )
  )
    .filter(Boolean)
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));

  return {
    ok: !checks.some((check) => check.status === "error"),
    generatedAt: new Date().toISOString(),
    system: {
      platform: process.platform,
      arch: process.arch,
      macOS: os.release(),
      node: process.version,
    },
    checks,
    permissions: {
      native: nativePermissions,
      capture: capturePermissions,
    },
    chrome: {
      ...chrome,
      cdpUrl: chromeCdpUrl,
      chromePath: launcherConfig.chromePath,
      profilePath: launcherConfig.profilePath,
    },
    stableBrowser,
    logs,
    logSharingWarning: options.logs === true ? LOG_SHARING_WARNING : null,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const report = await diagnose(options, env);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report, options.logs);
  return report.ok ? 0 : 1;
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
      process.stderr.write(`[controlmac-doctor] ${error.message}\n`);
      process.exitCode = 1;
    });
}
