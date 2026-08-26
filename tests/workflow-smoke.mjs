import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  app as foregroundApp,
  window_focus as foregroundWindowFocus,
} from "../opencode/tools/controlmac.ts";
import { startFixtureServer } from "./browser-fixture/server.mjs";
import {
  assertToolSucceeded,
  chromeMcpArgs,
  chromeMcpPath,
  connectMcp,
  customToolContext,
  gateReason,
  missingRequiredPermissions,
  nativeElementIdByIdentifier,
  nativeSnapshotId,
  peekabooCaptureMcpArgs,
  peekabooMcpArgs,
  peekabooPath,
  readCapturePeekabooPermissions,
  readNativePeekabooPermissions,
  requireFile,
  resultText,
  selectedPageId,
  snapshotUid,
  toolByName,
} from "./helpers.mjs";

function windowIdNamed(windowList, titleFragment) {
  const line = windowList
    .split(/\r?\n/)
    .find((candidate) => candidate.includes(titleFragment) && /\[ID:\s*\d+/i.test(candidate));
  return line ? Number(line.match(/\[ID:\s*(\d+)/i)[1]) : undefined;
}

async function waitForWindow(client, app, titleFragment, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastList = "";
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "window", arguments: { action: "list", app } });
    if (!result.isError) {
      lastList = resultText(result);
      const windowId = windowIdNamed(lastList, titleFragment);
      if (windowId !== undefined) return windowId;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Timed out waiting for ${app} window containing ${JSON.stringify(titleFragment)}:\n${lastList}`);
}

function parseForegroundResult(serialized, operation) {
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.status, "dispatched_unverified", `${operation} returned an unexpected status`);
  assert.equal(parsed.needs_reinspection, true, `${operation} incorrectly claimed self-verification`);
  return parsed;
}

async function inspectExactWindow(client, pid, windowId, retries = 3) {
  let result;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    result = await client.callTool({
      name: "inspect_ui",
      arguments: { app_target: `PID:${pid}`, window_id: windowId },
    });
    if (!result.isError) return result;
    if (!/snapshot is stale|receipt changed during traversal/i.test(resultText(result))) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return assertToolSucceeded(result, `inspect TextEdit PID ${pid} window ${windowId}`);
}

async function waitForFileContents(filePath, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await readFile(filePath, "utf8");
      if (last.includes(expected)) return last;
    } catch {
      // TextEdit has not flushed the saved contents yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`Timed out waiting for ${filePath} to contain ${JSON.stringify(expected)}; last content: ${JSON.stringify(last)}`);
}

test(
  "a file edited and saved in TextEdit can be uploaded and verified in Chrome",
  { skip: gateReason("CONTROLMAC_RUN_WORKFLOW_SMOKE"), timeout: 120_000 },
  async (t) => {
    if (process.platform !== "darwin") {
      t.skip("cross-application workflow requires macOS");
      return;
    }
    if (!(await requireFile(t, peekabooPath, "pinned Peekaboo CLI"))) return;
    if (!(await requireFile(t, chromeMcpPath, "Chrome DevTools MCP"))) return;

    const nativePermissions = await readNativePeekabooPermissions();
    const capturePermissions = await readCapturePeekabooPermissions();
    const missing = [
      ...nativePermissions
        .filter(
          (permission) =>
            ["Accessibility", "Event Synthesizing"].includes(permission.name) &&
            !permission.isGranted,
        )
        .map((permission) => `native ${permission.name}`),
      ...missingRequiredPermissions(capturePermissions).map((name) => `capture ${name}`),
    ];
    if (missing.length > 0) {
      t.skip(`missing required macOS permission(s): ${missing.join(", ")}`);
      return;
    }
    const fixture = await startFixtureServer();
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "controlmac-workflow-"));
    const marker = `workflow-${Date.now()}`;
    const sourcePath = path.join(temporaryRoot, `${marker}.txt`);
    await writeFile(sourcePath, "ControlMac workflow seed\n", "utf8");

    let nativeMcp;
    let captureMcp;
    let browserMcp;
    let textEditPid;
    let textEditWindowId;
    let pageId;
    t.after(async () => {
      if (browserMcp) {
        if (pageId !== undefined) {
          await browserMcp.client.callTool({ name: "close_page", arguments: { pageId } }).catch(() => {});
        }
        await browserMcp.close().catch(() => {});
      }
      if (nativeMcp) {
        if (textEditPid !== undefined && textEditWindowId !== undefined) {
          await nativeMcp.client.callTool({
            name: "window",
            arguments: { action: "close", app: `PID:${textEditPid}`, window_id: textEditWindowId },
          }).catch(() => {});
        }
        if (textEditPid !== undefined) {
          await nativeMcp.client.callTool({
            name: "app",
            arguments: { action: "quit", name: `PID:${textEditPid}`, force: true },
          }).catch(() => {});
        }
        await nativeMcp.close().catch(() => {});
      }
      if (captureMcp) await captureMcp.close().catch(() => {});
      await fixture.close().catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
    });

    nativeMcp = await connectMcp({ command: peekabooPath, args: peekabooMcpArgs });
    const nativeTools = (await nativeMcp.client.listTools()).tools;
    for (const name of ["app", "window", "inspect_ui", "set_value", "menu"]) {
      toolByName(nativeTools, name);
    }
    captureMcp = await connectMcp({ command: peekabooPath, args: peekabooCaptureMcpArgs });
    toolByName((await captureMcp.client.listTools()).tools, "image");

    const launch = parseForegroundResult(
      await foregroundApp.execute(
        {
          action: "launch",
          app: "TextEdit",
          open_targets: [sourcePath],
          new_instance: true,
          wait_ready: true,
          wait_for_window: true,
        },
        customToolContext(),
      ),
      "launch isolated TextEdit workflow fixture",
    );
    assert.ok(Number.isInteger(launch.data?.pid) && launch.data.pid > 0, "TextEdit launch returned no PID");
    textEditPid = launch.data.pid;
    textEditWindowId = await waitForWindow(nativeMcp.client, `PID:${textEditPid}`, path.basename(sourcePath));

    parseForegroundResult(
      await foregroundWindowFocus.execute(
        { pid: textEditPid, window_id: textEditWindowId },
        customToolContext(),
      ),
      "focus exact TextEdit workflow window",
    );
    let inspectionText = resultText(await inspectExactWindow(nativeMcp.client, textEditPid, textEditWindowId));
    assertToolSucceeded(
      await nativeMcp.client.callTool({
        name: "set_value",
        arguments: {
          snapshot: nativeSnapshotId(inspectionText),
          on: nativeElementIdByIdentifier(inspectionText, "First Text View", "textField"),
          value: `ControlMac workflow marker: ${marker}\n`,
        },
      }),
      "set exact TextEdit document contents",
    );
    inspectionText = resultText(await inspectExactWindow(nativeMcp.client, textEditPid, textEditWindowId));
    assert.match(inspectionText, new RegExp(marker), "TextEdit did not expose the updated document value");

    parseForegroundResult(
      await foregroundWindowFocus.execute(
        { pid: textEditPid, window_id: textEditWindowId },
        customToolContext(),
      ),
      "refocus exact TextEdit workflow window before save",
    );
    await inspectExactWindow(nativeMcp.client, textEditPid, textEditWindowId);
    assertToolSucceeded(
      await nativeMcp.client.callTool({
        name: "menu",
        arguments: { action: "click", app: `PID:${textEditPid}`, path: "File > Save" },
      }),
      "save exact TextEdit workflow document",
    );
    assert.match(await waitForFileContents(sourcePath, marker), new RegExp(marker));

    const nativeScreenshotPath = path.join(temporaryRoot, "textedit.png");
    assertToolSucceeded(
      await captureMcp.client.callTool({
        name: "image",
        arguments: {
          app_target: `PID:${textEditPid}`,
          window_id: textEditWindowId,
          format: "png",
          path: nativeScreenshotPath,
        },
      }),
      "capture workflow TextEdit screenshot",
    );
    const nativeScreenshot = await readFile(nativeScreenshotPath);
    assert.equal(nativeScreenshot.subarray(1, 4).toString("ascii"), "PNG");

    browserMcp = await connectMcp({
      command: process.execPath,
      args: [chromeMcpPath, ...chromeMcpArgs],
      timeoutMs: 30_000,
    });
    const browserTools = (await browserMcp.client.listTools()).tools;
    for (const name of ["list_pages", "new_page", "take_snapshot", "upload_file", "wait_for", "take_screenshot"]) {
      toolByName(browserTools, name);
    }

    assertToolSucceeded(
      await browserMcp.client.callTool({ name: "list_pages", arguments: {} }),
      "verify the normal Chrome connection before cross-application browser work",
    );

    const opened = assertToolSucceeded(
      await browserMcp.client.callTool({
        name: "new_page",
        arguments: { url: fixture.baseUrl, timeout: 15_000 },
      }),
      "open workflow fixture in normal Chrome",
    );
    pageId = selectedPageId(resultText(opened));
    const initialSnapshot = resultText(
      assertToolSucceeded(
        await browserMcp.client.callTool({ name: "take_snapshot", arguments: {} }),
        "inspect workflow fixture",
      ),
    );
    let uploadUid;
    for (const name of ["Choose a fixture file", "Choose File", "No file chosen"]) {
      try {
        uploadUid = snapshotUid(initialSnapshot, name);
        break;
      } catch {
        // Browser versions expose different accessible names for file inputs.
      }
    }
    assert.ok(uploadUid, `workflow fixture file input was not found:\n${initialSnapshot}`);
    assertToolSucceeded(
      await browserMcp.client.callTool({
        name: "upload_file",
        arguments: { uid: uploadUid, filePath: sourcePath },
      }),
      "upload TextEdit workflow file",
    );
    assertToolSucceeded(
      await browserMcp.client.callTool({
        name: "wait_for",
        arguments: { text: [path.basename(sourcePath), marker], timeout: 10_000 },
      }),
      "verify uploaded workflow file",
    );

    const browserScreenshot = assertToolSucceeded(
      await browserMcp.client.callTool({ name: "take_screenshot", arguments: { format: "png" } }),
      "capture workflow browser screenshot",
    );
    assert.ok(browserScreenshot.content?.some((item) => item.type === "image"));

    const finalBrowserState = resultText(
      assertToolSucceeded(
        await browserMcp.client.callTool({ name: "take_snapshot", arguments: {} }),
        "reinspect browser after switching control surfaces",
      ),
    );
    assert.match(finalBrowserState, new RegExp(marker));
  },
);
