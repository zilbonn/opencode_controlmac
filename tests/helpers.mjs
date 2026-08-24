import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const peekabooPath = path.join(repoRoot, "node_modules", ".bin", "peekaboo");
export const peekabooBridgeSocket =
  process.env.CONTROLMAC_PEEKABOO_BRIDGE_SOCKET ??
  path.join(os.homedir(), "Library/Application Support/Peekaboo/bridge.sock");
export const peekabooMcpArgs = ["mcp", "--no-remote"];
export const peekabooCaptureMcpArgs = ["mcp", "--bridge-socket", peekabooBridgeSocket];
export const chromeLauncherPath = path.join(repoRoot, "scripts", "chrome-beta-mcp.mjs");

export function enabled(name) {
  return process.env[name] === "1";
}

export function gateReason(name) {
  return enabled(name) ? false : `set ${name}=1 to run this live UI test`;
}

export async function requireFile(testContext, filePath, label = filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    testContext.skip(`${label} is unavailable`);
    return false;
  }
}

export function resultText(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function assertToolSucceeded(result, operation) {
  assert.notEqual(result?.isError, true, `${operation} failed:\n${resultText(result)}`);
  return result;
}

export function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `MCP tool ${name} was not advertised`);
  return tool;
}

export function snapshotUid(snapshotText, accessibleName, role) {
  const lines = snapshotText.split(/\r?\n/);
  const matches = lines.filter((line) => {
    const hasName = line.toLocaleLowerCase().includes(accessibleName.toLocaleLowerCase());
    const hasRole = role ? line.toLocaleLowerCase().includes(role.toLocaleLowerCase()) : true;
    return /uid=\S+/.test(line) && hasName && hasRole;
  });
  assert.equal(
    matches.length,
    1,
    `Expected one ${role ?? "element"} named ${JSON.stringify(accessibleName)}; got ${matches.length}:\n${matches.join("\n")}`,
  );
  return matches[0].match(/uid=(\S+)/)[1];
}

export function selectedPageId(pageListText) {
  const selected = pageListText
    .split(/\r?\n/)
    .find((line) => /\[selected\]/i.test(line) && /^\s*\d+\s*:/.test(line));
  assert.ok(selected, `No selected browser page was reported:\n${pageListText}`);
  return Number(selected.match(/^\s*(\d+)\s*:/)[1]);
}

export function firstJsonObject(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `No JSON object was returned:\n${text}`);
  return JSON.parse(text.slice(start, end + 1));
}

export function nativeSnapshotId(inspectionText) {
  const match = inspectionText.match(/^Snapshot ID:\s*(\S+)\s*$/m);
  assert.ok(match, `Native inspection returned no snapshot ID:\n${inspectionText}`);
  return match[1];
}

export function nativeElementId(inspectionText, accessibleName, section) {
  let currentSection;
  const matches = [];
  for (const line of inspectionText.split(/\r?\n/)) {
    const heading = line.match(/^([A-Za-z][A-Za-z ]*) \(\d+ found/);
    if (heading) currentSection = heading[1];
    if (!/^\s*\S+\s+-\s+"/.test(line)) continue;
    if (!line.toLocaleLowerCase().includes(`"${accessibleName.toLocaleLowerCase()}"`)) continue;
    if (section && currentSection?.toLocaleLowerCase() !== section.toLocaleLowerCase()) continue;
    matches.push(line);
  }
  assert.equal(
    matches.length,
    1,
    `Expected one native element named ${JSON.stringify(accessibleName)}; got ${matches.length}:\n${matches.join("\n")}`,
  );
  return matches[0].trim().match(/^(\S+)\s+-/)[1];
}

export function nativeElementIdByIdentifier(inspectionText, identifier, section) {
  let currentSection;
  let currentElement;
  const elements = [];
  const finishElement = () => {
    if (currentElement) elements.push(currentElement);
    currentElement = undefined;
  };

  for (const line of inspectionText.split(/\r?\n/)) {
    const heading = line.match(/^([A-Za-z][A-Za-z ]*) \(\d+ found/);
    if (heading) {
      finishElement();
      currentSection = heading[1];
      continue;
    }
    const element = line.match(/^\s*(\S+)\s+-\s+"/);
    if (element) {
      finishElement();
      currentElement = { id: element[1], section: currentSection, text: line };
      continue;
    }
    if (currentElement) currentElement.text += `\n${line}`;
  }
  finishElement();

  const matches = [];
  for (const element of elements) {
    if (!element.text.toLocaleLowerCase().includes(`identifier: ${identifier.toLocaleLowerCase()}`)) continue;
    if (section && element.section?.toLocaleLowerCase() !== section.toLocaleLowerCase()) continue;
    matches.push(element);
  }
  assert.equal(
    matches.length,
    1,
    `Expected one native element with identifier ${JSON.stringify(identifier)}; got ${matches.length}:\n${matches.map((element) => element.text).join("\n")}\nInspection:\n${inspectionText}`,
  );
  return matches[0].id;
}

export function nativeWindowId(windowListText, titleFragment) {
  const matches = windowListText
    .split(/\r?\n/)
    .filter((line) => line.includes(titleFragment) && /\[ID:\s*\d+/i.test(line));
  assert.equal(
    matches.length,
    1,
    `Expected one native window containing ${JSON.stringify(titleFragment)}; got ${matches.length}:\n${matches.join("\n")}`,
  );
  return Number(matches[0].match(/\[ID:\s*(\d+)/i)[1]);
}

export function customToolContext() {
  return {
    abort: new AbortController().signal,
    metadata() {},
  };
}

export async function connectMcp({ command, args = [], env = process.env, cwd = repoRoot, timeoutMs = 20_000 }) {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "controlmac-smoke-tests", version: "0.1.0" });
  const timeout = AbortSignal.timeout(timeoutMs);
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => timeout.addEventListener("abort", () => reject(new Error(`MCP startup timed out.\n${stderr}`)), { once: true })),
  ]);
  return {
    client,
    stderr: () => stderr,
    close: () => client.close(),
  };
}

async function readPeekabooPermissions(runtimeArgs, expectedSource) {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    peekabooPath,
    ["permissions", "status", ...runtimeArgs, "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, `peekaboo permissions failed:\n${stderr}`);
  const parsed = JSON.parse(stdout);
  assert.equal(
    parsed?.data?.source,
    expectedSource,
    `Peekaboo permission check did not use the expected ${expectedSource} source`,
  );
  const permissions = parsed?.data?.permissions;
  assert.ok(Array.isArray(permissions), "Peekaboo returned no permissions array");
  return permissions;
}

export function readNativePeekabooPermissions() {
  return readPeekabooPermissions(["--no-remote"], "local");
}

export function readCapturePeekabooPermissions() {
  return readPeekabooPermissions(
    ["--bridge-socket", peekabooBridgeSocket],
    "bridge",
  );
}

export function missingRequiredPermissions(permissions) {
  return permissions.filter((permission) => permission.isRequired && !permission.isGranted).map((permission) => permission.name);
}

export async function loadPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}
