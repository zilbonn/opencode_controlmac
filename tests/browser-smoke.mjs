import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getLauncherConfig, inspectLauncherState } from "../scripts/chrome-beta-mcp.mjs";
import { startFixtureServer } from "./browser-fixture/server.mjs";
import {
  assertToolSucceeded,
  chromeLauncherPath,
  connectMcp,
  firstJsonObject,
  gateReason,
  requireFile,
  resultText,
  selectedPageId,
  snapshotUid,
  toolByName,
} from "./helpers.mjs";

test(
  "Chrome DevTools MCP controls every fixture interaction class",
  { skip: gateReason("CONTROLMAC_RUN_BROWSER_SMOKE"), timeout: 90_000 },
  async (t) => {
    if (process.platform !== "darwin") {
      t.skip("the configured Chrome Beta launcher is macOS-specific");
      return;
    }
    if (!(await requireFile(t, chromeLauncherPath, "Chrome Beta MCP launcher"))) return;

    const launcherState = await inspectLauncherState(getLauncherConfig());
    if (launcherState.blocker) {
      t.skip(`Chrome Beta prerequisite blocked: ${launcherState.blocker}`);
      return;
    }

    const fixture = await startFixtureServer();
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "controlmac-browser-smoke-"));
    const uploadPath = path.join(temporaryRoot, "controlmac-upload.txt");
    const uploadContents = `ControlMac upload ${Date.now()}`;
    await writeFile(uploadPath, uploadContents, "utf8");
    t.after(async () => {
      await fixture.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    });

    const mcp = await connectMcp({ command: process.execPath, args: [chromeLauncherPath], timeoutMs: 30_000 });
    let pageId;
    t.after(async () => {
      if (pageId !== undefined) {
        await mcp.client.callTool({ name: "close_page", arguments: { pageId } }).catch(() => {});
      }
      await mcp.close();
    });

    const { tools } = await mcp.client.listTools();
    for (const name of [
      "new_page",
      "close_page",
      "take_snapshot",
      "click",
      "fill",
      "wait_for",
      "handle_dialog",
      "drag",
      "upload_file",
      "evaluate_script",
      "click_at",
      "take_screenshot",
    ]) {
      toolByName(tools, name);
    }

    const opened = assertToolSucceeded(
      await mcp.client.callTool({
        name: "new_page",
        arguments: { url: `${fixture.baseUrl}/?delay=200`, timeout: 15_000 },
      }),
      "open fixture page",
    );
    pageId = selectedPageId(resultText(opened));

    let snapshot = resultText(
      assertToolSucceeded(
        await mcp.client.callTool({ name: "take_snapshot", arguments: {} }),
        "take initial page snapshot",
      ),
    );
    assert.match(snapshot, /ControlMac Browser Fixture/);

    const messageMarker = `browser-smoke-${Date.now()}`;
    const inputUid = snapshotUid(snapshot, "Message", "textbox");
    const submitUid = snapshotUid(snapshot, "Submit message", "button");
    assertToolSucceeded(
      await mcp.client.callTool({ name: "fill", arguments: { uid: inputUid, value: messageMarker } }),
      "fill message input",
    );
    assertToolSucceeded(
      await mcp.client.callTool({ name: "click", arguments: { uid: submitUid } }),
      "submit message",
    );
    const submitted = assertToolSucceeded(
      await mcp.client.callTool({
        name: "wait_for",
        arguments: { text: [`Submitted: ${messageMarker}`], timeout: 5_000 },
      }),
      "verify submitted message",
    );
    assert.match(resultText(submitted), new RegExp(messageMarker));

    snapshot = resultText(await mcp.client.callTool({ name: "take_snapshot", arguments: {} }));
    const delayUid = snapshotUid(snapshot, "Load delayed content", "button");
    assertToolSucceeded(
      await mcp.client.callTool({ name: "click", arguments: { uid: delayUid } }),
      "start delayed content",
    );
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "wait_for",
        arguments: { text: ["Delayed content ready"], timeout: 5_000 },
      }),
      "wait for delayed content",
    );

    snapshot = resultText(await mcp.client.callTool({ name: "take_snapshot", arguments: {} }));
    const dialogUid = snapshotUid(snapshot, "Open browser dialog", "button");
    const dialogDispatch = await mcp.client.callTool({
      name: "click",
      arguments: { uid: dialogUid },
    });
    if (dialogDispatch.isError) {
      // Chrome DevTools MCP may report the interrupted click wait as an error even
      // though the expected dialog is now open. The observed dialog is the success state.
      assert.match(resultText(dialogDispatch), /Open dialog|Call handle_dialog/i);
    }
    assertToolSucceeded(
      await mcp.client.callTool({ name: "handle_dialog", arguments: { action: "accept" } }),
      "accept browser dialog",
    );
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "wait_for",
        arguments: { text: ["Browser dialog accepted"], timeout: 5_000 },
      }),
      "verify browser dialog result",
    );

    snapshot = resultText(await mcp.client.callTool({ name: "take_snapshot", arguments: {} }));
    const fromUid = snapshotUid(snapshot, "Drag source");
    const toUid = snapshotUid(snapshot, "Drop target");
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "drag",
        arguments: { from_uid: fromUid, to_uid: toUid },
      }),
      "drag fixture element",
    );
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "wait_for",
        arguments: { text: ["Drag completed"], timeout: 5_000 },
      }),
      "verify drag result",
    );

    snapshot = resultText(await mcp.client.callTool({ name: "take_snapshot", arguments: {} }));
    let uploadUid;
    for (const candidate of ["Choose a fixture file", "Choose File", "No file chosen"]) {
      try {
        uploadUid = snapshotUid(snapshot, candidate);
        break;
      } catch {
        // Try the next browser-specific accessible name.
      }
    }
    assert.ok(uploadUid, `file input was not represented in the page snapshot:\n${snapshot}`);
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "upload_file",
        arguments: { uid: uploadUid, filePath: uploadPath },
      }),
      "upload fixture file",
    );
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "wait_for",
        arguments: { text: [path.basename(uploadPath), uploadContents], timeout: 5_000 },
      }),
      "verify uploaded file",
    );

    const canvasPositionResult = assertToolSucceeded(
      await mcp.client.callTool({
        name: "evaluate_script",
        arguments: {
          function:
            "() => { const r = document.querySelector('#visual-canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }",
        },
      }),
      "locate visual-only canvas target",
    );
    const canvasPosition = firstJsonObject(resultText(canvasPositionResult));
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "click_at",
        arguments: { x: canvasPosition.x, y: canvasPosition.y },
      }),
      "click visual-only canvas target",
    );
    assertToolSucceeded(
      await mcp.client.callTool({
        name: "wait_for",
        arguments: { text: ["Canvas target activated"], timeout: 5_000 },
      }),
      "verify canvas coordinate action",
    );

    const screenshot = assertToolSucceeded(
      await mcp.client.callTool({ name: "take_screenshot", arguments: { format: "png" } }),
      "capture browser screenshot",
    );
    assert.ok(screenshot.content?.some((item) => item.type === "image"), "browser screenshot returned no image content");
  },
);
