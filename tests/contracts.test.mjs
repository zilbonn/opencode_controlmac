import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";

import { buildInstallPlan, desiredMcpEntries, updateConfigText } from "../scripts/install.mjs";
import {
  app,
  dialog_file,
  drag,
  window_focus,
} from "../opencode/tools/controlmac.ts";
import { startFixtureServer } from "./browser-fixture/server.mjs";
import { loadPackageJson, repoRoot } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

test("runtime dependencies and engine are exactly pinned", async () => {
  const packageJson = await loadPackageJson();
  assert.equal(packageJson.engines.node, "^24.15.0 || >=26.0.0");
  assert.deepEqual(packageJson.dependencies, {
    "@steipete/peekaboo": "4.2.2",
    "chrome-devtools-mcp": "1.7.0",
    semver: "7.8.5",
  });
  assert.equal(packageJson.devDependencies["@modelcontextprotocol/sdk"], "1.30.0");
  assert.equal(packageJson.devDependencies["@opencode-ai/plugin"], "1.18.21");
  assert.equal(packageJson.devDependencies["jsonc-parser"], "3.3.1");
});

test("installer adds only ControlMac MCP entries and preserves unrelated JSONC", () => {
  const existing = `{
  // This comment and the unrelated integrations must survive.
  "mcp": {
    "caido-tahr": { "type": "local", "command": ["caido-tahr"] },
    "playwright": { "type": "remote", "url": "http://127.0.0.1:3000/mcp" },
  },
  "permission": "allow",
}
`;
  const paths = {
    peekabooPath: "/fixture/repo/node_modules/.bin/peekaboo",
    peekabooBridgeSocket: "/fixture/home/Library/Application Support/Peekaboo/bridge.sock",
    chromeMcpPath: "/fixture/repo/node_modules/.bin/chrome-devtools-mcp",
    stableChromeMcpLogPath: "/fixture/home/Library/Logs/OpenCodeControl/chrome-devtools-stable.log",
    launcherPath: "/fixture/repo/scripts/chrome-beta-mcp.mjs",
  };
  const entries = desiredMcpEntries(paths, "/fixture/node");
  assert.deepEqual(entries["controlmac-native"].command, [
    paths.peekabooPath,
    "mcp",
    "--no-remote",
  ]);
  assert.deepEqual(entries["controlmac-capture"].command, [
    paths.peekabooPath,
    "mcp",
    "--bridge-socket",
    paths.peekabooBridgeSocket,
  ]);
  assert.deepEqual(entries["controlmac-stable-browser"], {
    type: "local",
    command: [
      "/fixture/node",
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
  });
  const once = updateConfigText(existing, entries, "fixture-opencode.jsonc");
  const twice = updateConfigText(once, entries, "fixture-opencode.jsonc");
  const errors = [];
  const parsed = parse(twice, errors, { allowTrailingComma: true });

  assert.deepEqual(errors, []);
  assert.match(twice, /This comment and the unrelated integrations must survive/);
  assert.equal(parsed.permission, "allow");
  assert.deepEqual(parsed.mcp["caido-tahr"], { type: "local", command: ["caido-tahr"] });
  assert.deepEqual(parsed.mcp.playwright, { type: "remote", url: "http://127.0.0.1:3000/mcp" });
  assert.deepEqual(parsed.mcp["controlmac-native"], entries["controlmac-native"]);
  assert.deepEqual(parsed.mcp["controlmac-capture"], entries["controlmac-capture"]);
  assert.deepEqual(parsed.mcp["controlmac-browser"], entries["controlmac-browser"]);
  assert.deepEqual(
    parsed.mcp["controlmac-stable-browser"],
    entries["controlmac-stable-browser"],
  );
  assert.equal(twice, once, "reapplying the same MCP entries must be idempotent");
});

test("installer refuses to replace a symlink-managed OpenCode config", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "controlmac-install-contract-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const managedConfig = path.join(temporaryRoot, "managed.jsonc");
  const configLink = path.join(temporaryRoot, "opencode.jsonc");
  await writeFile(managedConfig, "{}\n");
  await symlink(managedConfig, configLink);

  await assert.rejects(
    buildInstallPlan({ configPath: configLink }),
    /refusing to replace symlink-managed OpenCode config/i,
  );
  assert.equal(await readFile(managedConfig, "utf8"), "{}\n");
});

test("reference config advertises the four distinct local MCP servers", async () => {
  const fragmentText = await readFile(path.join(repoRoot, "config", "opencode.fragment.jsonc"), "utf8");
  const errors = [];
  const fragment = parse(fragmentText, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(fragment.mcp).sort(), [
    "controlmac-browser",
    "controlmac-capture",
    "controlmac-native",
    "controlmac-stable-browser",
  ]);
  assert.deepEqual(fragment.mcp["controlmac-native"].command.slice(1), [
    "mcp",
    "--no-remote",
  ]);
  assert.deepEqual(fragment.mcp["controlmac-capture"].command.slice(1), [
    "mcp",
    "--bridge-socket",
    "<home>/Library/Application Support/Peekaboo/bridge.sock",
  ]);
  assert.deepEqual(fragment.mcp["controlmac-stable-browser"].command.slice(2, 4), [
    "--auto-connect",
    "--channel=stable",
  ]);
  assert.match(
    fragment.mcp["controlmac-stable-browser"].command[1],
    /node_modules\/\.bin\/chrome-devtools-mcp$/,
  );
  assert.match(fragment.mcp["controlmac-native"].command[0], /node_modules\/\.bin\/peekaboo$/);
  assert.match(fragment.mcp["controlmac-capture"].command[0], /node_modules\/\.bin\/peekaboo$/);
  assert.match(fragment.mcp["controlmac-browser"].command[1], /scripts\/chrome-beta-mcp\.mjs$/);
  assert.equal(fragment.mcp["controlmac-browser"].command[0], "<node-path>");
  assert.match(fragment.mcp["controlmac-native"].command[0], /^<repo-root>\//);
  assert.match(fragment.mcp["controlmac-capture"].command[0], /^<repo-root>\//);
  assert.match(fragment.mcp["controlmac-stable-browser"].command[1], /^<repo-root>\//);
  assert.match(
    fragment.mcp["controlmac-stable-browser"].command.at(-1),
    /^--log-file=<home>\//,
  );
  assert.doesNotMatch(fragmentText, /\/Users\//);
  for (const entry of Object.values(fragment.mcp)) {
    assert.equal(entry.type, "local");
    assert.equal(entry.enabled, true);
    assert.equal(entry.timeout, 30_000);
  }
});

test("public sources contain no private-machine or retired fixed-endpoint markers", async () => {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const sourcePaths = stdout.split("\0").filter(Boolean);
  const forbiddenTokens = [
    ["", "Users", "jacob"].join("/"),
    ["MacBook", "Pro.local"].join("-"),
    String(9_000 + 223),
    ["CONTROLMAC", "CDP", "HOST"].join("_"),
    ["CONTROLMAC", "CDP", "PORT"].join("_"),
  ];

  for (const relativePath of sourcePaths) {
    const contents = await readFile(path.join(repoRoot, relativePath), "utf8");
    for (const token of forbiddenTokens) {
      assert.equal(
        contents.includes(token),
        false,
        `${relativePath} contains forbidden public-release marker ${token}`,
      );
    }
  }
});

test("foreground wrappers expose narrow schemas and reject ambiguous targets before dispatch", async () => {
  const wrapperSource = await readFile(
    path.join(repoRoot, "opencode", "tools", "controlmac.ts"),
    "utf8",
  );
  assert.doesNotMatch(wrapperSource, /--bridge-socket/);
  assert.deepEqual(Object.keys(app.args), [
    "action",
    "app",
    "bundle_id",
    "open_targets",
    "new_instance",
    "wait_ready",
    "wait_for_window",
    "relaunch_wait_ms",
    "timeout_ms",
  ]);
  assert.deepEqual(Object.keys(dialog_file.args), [
    "app",
    "window_id",
    "path",
    "name",
    "select",
    "ensure_expanded",
    "timeout_ms",
  ]);
  assert.deepEqual(Object.keys(window_focus.args), [
    "pid",
    "window_id",
    "space_mode",
    "timeout_ms",
    "retries",
  ]);
  assert.deepEqual(Object.keys(drag.args), [
    "app",
    "window_id",
    "snapshot",
    "from",
    "to",
    "to_app",
    "duration_ms",
    "steps",
    "modifiers",
  ]);
  assert.equal(typeof drag.execute, "function");
  assert.match(drag.description, /fresh snapshot/i);
  assert.match(drag.description, /inspect the destination afterward/i);

  const context = {
    abort: new AbortController().signal,
    metadata() {},
  };
  await assert.rejects(
    app.execute({ action: "launch" }, context),
    /exactly one application target/i,
  );
  await assert.rejects(
    dialog_file.execute({ path: "/tmp" }, context),
    /exact dialog target/i,
  );
  await assert.rejects(
    window_focus.execute({}, context),
    /exact positive pid/i,
  );
  await assert.rejects(
    drag.execute({ snapshot: "snapshot", from: "source" }, context),
    /exactly one destination/i,
  );
  await assert.rejects(
    drag.execute(
      { snapshot: "snapshot", from: "source", to: "target", to_app: "Finder" },
      context,
    ),
    /exactly one destination/i,
  );
});

test("foreground app wrapper resolves project-relative open targets from ToolContext", async () => {
  const source = await readFile(path.join(repoRoot, "opencode", "tools", "controlmac.ts"), "utf8");
  assert.match(source, /resolveOpenTarget\(openTarget, context\.directory\)/);
  assert.match(source, /path\.resolve\(directory, value\)/);
});

test("control-mac skill defines routing, snapshot freshness, verification, and bounded recovery", async () => {
  const skill = await readFile(path.join(repoRoot, "opencode", "skills", "control-mac", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: control-mac\n/m);
  assert.match(skill, /controlmac-browser/);
  assert.match(skill, /controlmac-stable-browser/);
  assert.match(skill, /controlmac-native/);
  assert.match(skill, /controlmac-capture/);
  assert.match(skill, /format: "data"/);
  assert.match(skill, /absolute `path`/);
  assert.match(skill, /controlmac_app/);
  assert.match(skill, /controlmac_window_focus/);
  assert.match(skill, /controlmac_dialog_file/);
  assert.match(skill, /controlmac_drag/);
  assert.match(skill, /background-only/i);
  assert.match(skill, /snapshot-scoped/i);
  assert.match(skill, /dispatched_unverified/);
  assert.match(skill, /retry-safe semantic action once/i);
  assert.match(skill, /one fresh coordinate fallback and one fresh OCR\/vision fallback/i);
  assert.match(skill, /5 seconds.*15 seconds.*30 seconds/s);
  assert.match(skill, /last verified checkpoint/i);
});

test("browser fixture is healthy and includes every required interaction surface", async (t) => {
  const fixture = await startFixtureServer();
  t.after(fixture.close);

  const healthResponse = await fetch(`${fixture.baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true, fixture: "controlmac-browser" });

  const pageResponse = await fetch(fixture.baseUrl);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type"), /^text\/html/);
  const page = await pageResponse.text();
  for (const id of [
    "message-input",
    "submit-message",
    "start-delay",
    "open-html-dialog",
    "open-native-dialog",
    "drag-source",
    "drop-target",
    "file-input",
    "visual-canvas",
    "viewport-status",
  ]) {
    assert.match(page, new RegExp(`id=["']${id}["']`));
  }

  const scriptResponse = await fetch(`${fixture.baseUrl}/fixture.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /^text\/javascript/);
  const script = await scriptResponse.text();
  assert.match(script, /showModal\(\)/);
  assert.match(script, /window\.confirm/);
  assert.match(script, /dataTransfer/);
  assert.match(script, /file\.text\(\)/);
  assert.match(script, /getBoundingClientRect\(\)/);

  const missingResponse = await fetch(`${fixture.baseUrl}/does-not-exist`);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { ok: false, error: "not_found" });
});
