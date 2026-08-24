#!/usr/bin/env node

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);

class InstallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InstallError";
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

function takeValue(argv, index, name) {
  const current = argv[index];
  const equalsPrefix = `${name}=`;
  if (current.startsWith(equalsPrefix)) {
    return { value: current.slice(equalsPrefix.length), consumed: 1 };
  }
  if (current === name && argv[index + 1]) {
    return { value: argv[index + 1], consumed: 2 };
  }
  return null;
}

export function parseArguments(argv) {
  const options = { dryRun: false, json: false };
  for (let index = 0; index < argv.length; ) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      index += 1;
      continue;
    }
    const configDir = takeValue(argv, index, "--config-dir");
    if (configDir) {
      options.configDir = configDir.value;
      index += configDir.consumed;
      continue;
    }
    const configPath = takeValue(argv, index, "--config");
    if (configPath) {
      options.configPath = configPath.value;
      index += configPath.consumed;
      continue;
    }
    throw new InstallError(
      "Usage: install.mjs [--dry-run] [--json] [--config-dir PATH | --config PATH]",
      { unknownArgument: argument },
    );
  }
  if (options.configDir && options.configPath) {
    throw new InstallError("Use either --config-dir or --config, not both");
  }
  return options;
}

export function getInstallPaths(options = {}, env = process.env) {
  const homeDirectory = absolutePath(env.HOME ?? os.homedir(), os.homedir());
  const defaultConfigDir = env.XDG_CONFIG_HOME
    ? path.join(absolutePath(env.XDG_CONFIG_HOME, homeDirectory), "opencode")
    : path.join(homeDirectory, ".config/opencode");
  const configuredDirectory =
    options.configDir ??
    env.CONTROLMAC_OPENCODE_CONFIG_DIR ??
    env.OPENCODE_CONFIG_DIR ??
    defaultConfigDir;
  const configPathFromEnvironment =
    env.CONTROLMAC_OPENCODE_CONFIG ?? env.OPENCODE_CONFIG;
  const configPath = absolutePath(
    options.configPath ??
      configPathFromEnvironment ??
      path.join(absolutePath(configuredDirectory, homeDirectory), "opencode.jsonc"),
    homeDirectory,
  );
  const configDirectory = path.dirname(configPath);

  return {
    homeDirectory,
    configDirectory,
    configPath,
    skillSource: path.join(REPO_ROOT, "opencode/skills/control-mac"),
    skillTarget: path.join(configDirectory, "skills/control-mac"),
    toolSource: path.join(REPO_ROOT, "opencode/tools/controlmac.ts"),
    toolTarget: path.join(configDirectory, "tools/controlmac.ts"),
    peekabooPath: path.join(REPO_ROOT, "node_modules/.bin/peekaboo"),
    peekabooBridgeSocket: path.join(
      homeDirectory,
      "Library/Application Support/Peekaboo/bridge.sock",
    ),
    chromeMcpPath: path.join(REPO_ROOT, "node_modules/.bin/chrome-devtools-mcp"),
    stableChromeMcpLogPath: path.join(
      homeDirectory,
      "Library/Logs/OpenCodeControl/chrome-devtools-stable.log",
    ),
    stableChromeDevToolsActivePortPath: path.join(
      homeDirectory,
      "Library/Application Support/Google/Chrome/DevToolsActivePort",
    ),
    launcherPath: path.join(REPO_ROOT, "scripts/chrome-beta-mcp.mjs"),
  };
}

export function desiredMcpEntries(paths, nodePath = process.execPath) {
  return {
    "controlmac-native": {
      type: "local",
      command: [paths.peekabooPath, "mcp", "--no-remote"],
      environment: {
        PEEKABOO_LOG_LEVEL: "info",
      },
      enabled: true,
      timeout: 30_000,
    },
    "controlmac-capture": {
      type: "local",
      command: [paths.peekabooPath, "mcp", "--bridge-socket", paths.peekabooBridgeSocket],
      environment: {
        PEEKABOO_LOG_LEVEL: "info",
      },
      enabled: true,
      timeout: 30_000,
    },
    "controlmac-browser": {
      type: "local",
      command: [nodePath, paths.launcherPath],
      enabled: true,
      timeout: 30_000,
    },
    "controlmac-stable-browser": {
      type: "local",
      command: [
        nodePath,
        paths.chromeMcpPath,
        "--auto-connect",
        "--channel=stable",
        "--experimental-vision",
        "--no-category-performance",
        "--no-category-network",
        "--no-category-emulation",
        "--allow-unrestricted-paths",
        "--no-usage-statistics",
        `--log-file=${paths.stableChromeMcpLogPath}`,
      ],
      enabled: true,
      timeout: 30_000,
    },
  };
}

function formattingOptions(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentation = text.match(/\r?\n([ \t]+)\S/);
  const whitespace = indentation?.[1] ?? "  ";
  return {
    insertSpaces: !whitespace.includes("\t"),
    tabSize: whitespace.includes("\t") ? 2 : Math.max(1, whitespace.length),
    eol,
  };
}

function parseJsonc(text, sourceName) {
  const errors = [];
  const parsed = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const description = errors
      .slice(0, 3)
      .map(
        ({ error, offset }) =>
          `${printParseErrorCode(error)} at character ${offset}`,
      )
      .join(", ");
    throw new InstallError(`Cannot edit invalid JSONC in ${sourceName}: ${description}`);
  }
  if (parsed === undefined || parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new InstallError(`${sourceName} must contain a JSON object`);
  }
  if (
    Object.hasOwn(parsed, "mcp") &&
    (parsed.mcp === null || Array.isArray(parsed.mcp) || typeof parsed.mcp !== "object")
  ) {
    throw new InstallError(`The mcp property in ${sourceName} must be a JSON object`);
  }
  return parsed;
}

export function updateConfigText(currentText, entries, sourceName = "opencode.jsonc") {
  const initialText = currentText.trim() === "" ? "{}\n" : currentText;
  parseJsonc(initialText, sourceName);
  const options = { formattingOptions: formattingOptions(initialText) };
  let updated = initialText;
  for (const [name, value] of Object.entries(entries)) {
    const edits = modify(updated, ["mcp", name], value, options);
    updated = applyEdits(updated, edits);
  }
  if (!updated.endsWith(options.formattingOptions.eol)) {
    updated += options.formattingOptions.eol;
  }
  return updated;
}

async function statIfPresent(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectLink(source, target) {
  const sourceStat = await statIfPresent(source);
  if (!sourceStat) {
    throw new InstallError(`Required project source is missing: ${source}`);
  }
  const targetStat = await statIfPresent(target);
  if (!targetStat) return { action: "create", source, target };
  if (!targetStat.isSymbolicLink()) {
    throw new InstallError(
      `Refusing to replace a non-symlink OpenCode path: ${target}`,
    );
  }
  const linkValue = await readlink(target);
  const resolvedLink = path.resolve(path.dirname(target), linkValue);
  if (resolvedLink === path.resolve(source)) {
    return { action: "unchanged", source, target };
  }
  return {
    action: "replace-symlink",
    source,
    target,
    previousTarget: resolvedLink,
  };
}

async function installLink(operation) {
  if (operation.action === "unchanged") return;
  await mkdir(path.dirname(operation.target), { recursive: true });
  const temporary = `${operation.target}.tmp-${process.pid}-${randomUUID()}`;
  await symlink(operation.source, temporary);
  try {
    // POSIX rename replaces the existing symlink atomically, so an interrupted
    // update cannot leave the global OpenCode path missing.
    await rename(temporary, operation.target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function backupName(configPath) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  return `${configPath}.bak-${timestamp}`;
}

async function atomicWrite(filePath, contents, existingMode = 0o600) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { mode: existingMode });
  try {
    await rename(temporary, filePath);
    await chmod(filePath, existingMode);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function buildInstallPlan(options = {}, env = process.env) {
  const paths = getInstallPaths(options, env);
  const [configStat, skill, tool] = await Promise.all([
    statIfPresent(paths.configPath),
    inspectLink(paths.skillSource, paths.skillTarget),
    inspectLink(paths.toolSource, paths.toolTarget),
  ]);
  if (configStat?.isSymbolicLink()) {
    throw new InstallError(
      `Refusing to replace symlink-managed OpenCode config: ${paths.configPath}`,
    );
  }
  if (configStat && !configStat.isFile()) {
    throw new InstallError(`OpenCode config is not a regular file: ${paths.configPath}`);
  }
  const currentConfig = configStat
    ? await readFile(paths.configPath, "utf8")
    : "{}\n";
  const entries = desiredMcpEntries(paths, process.execPath);
  const updatedConfig = updateConfigText(currentConfig, entries, paths.configPath);
  const configChanged = updatedConfig !== currentConfig;

  return {
    paths,
    configExists: Boolean(configStat),
    configMode: configStat?.mode ? configStat.mode & 0o777 : 0o600,
    configChanged,
    currentConfig,
    updatedConfig,
    links: [skill, tool],
  };
}

function publicPlan(plan, dryRun, backupPath = null) {
  return {
    ok: true,
    dryRun,
    config: {
      path: plan.paths.configPath,
      action: plan.configChanged
        ? plan.configExists
          ? "update"
          : "create"
        : "unchanged",
      backup: backupPath,
      preservedMcpEntries: true,
    },
    links: plan.links.map(({ action, source, target, previousTarget }) => ({
      action,
      source,
      target,
      ...(previousTarget ? { previousTarget } : {}),
    })),
    mcpEntries: [
      "controlmac-native",
      "controlmac-capture",
      "controlmac-browser",
      "controlmac-stable-browser",
    ],
  };
}

function printHuman(result) {
  const prefix = result.dryRun ? "Would" : "Did";
  process.stdout.write(`${result.dryRun ? "Dry run" : "Install complete"}\n`);
  process.stdout.write(`- ${prefix} ${result.config.action} ${result.config.path}\n`);
  if (result.config.backup) {
    process.stdout.write(`- Backed up config to ${result.config.backup}\n`);
  }
  for (const link of result.links) {
    process.stdout.write(`- ${prefix} ${link.action} ${link.target} -> ${link.source}\n`);
  }
  process.stdout.write(
    "- MCP entries: controlmac-native, controlmac-capture, controlmac-browser, controlmac-stable-browser\n",
  );
}

export async function install(options = {}, env = process.env) {
  const plan = await buildInstallPlan(options, env);
  if (options.dryRun) return publicPlan(plan, true);

  await mkdir(path.dirname(plan.paths.stableChromeMcpLogPath), { recursive: true });
  for (const link of plan.links) await installLink(link);

  let backupPath = null;
  if (plan.configChanged) {
    await mkdir(plan.paths.configDirectory, { recursive: true });
    const latestStat = await statIfPresent(plan.paths.configPath);
    if (latestStat?.isSymbolicLink()) {
      throw new InstallError(
        `Refusing to replace symlink-managed OpenCode config: ${plan.paths.configPath}`,
      );
    }
    if (latestStat && !latestStat.isFile()) {
      throw new InstallError(`OpenCode config is not a regular file: ${plan.paths.configPath}`);
    }
    const latestConfig = latestStat
      ? await readFile(plan.paths.configPath, "utf8")
      : "{}\n";
    if (Boolean(latestStat) !== plan.configExists || latestConfig !== plan.currentConfig) {
      throw new InstallError(
        `OpenCode config changed while installing; rerun without modifying it concurrently: ${plan.paths.configPath}`,
      );
    }
    if (plan.configExists) {
      backupPath = backupName(plan.paths.configPath);
      await copyFile(plan.paths.configPath, backupPath);
    }
    await atomicWrite(
      plan.paths.configPath,
      plan.updatedConfig,
      plan.configMode,
    );
  }
  return publicPlan(plan, false, backupPath);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const result = await install(options, env);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(result);
  return 0;
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[controlmac-install] ${message}\n`);
    if (error instanceof InstallError && Object.keys(error.details).length > 0) {
      process.stderr.write(`${JSON.stringify(error.details)}\n`);
    }
    process.exitCode = 1;
  });
}
