import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  app as foregroundApp,
  drag as foregroundDrag,
  window_focus as foregroundWindowFocus,
} from "../opencode/tools/controlmac.ts";
import {
  assertToolSucceeded,
  connectMcp,
  customToolContext,
  gateReason,
  nativeElementId,
  nativeElementIdByIdentifier,
  nativeSnapshotId,
  nativeWindowId,
  peekabooCaptureMcpArgs,
  peekabooMcpArgs,
  peekabooPath,
  readCapturePeekabooPermissions,
  readNativePeekabooPermissions,
  requireFile,
  resultText,
  toolByName,
} from "./helpers.mjs";

function parseCustomResult(serialized, operation) {
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.status, "dispatched_unverified", `${operation} returned an unexpected status`);
  assert.equal(parsed.needs_reinspection, true, `${operation} incorrectly claimed self-verification`);
  assert.ok(parsed.data && typeof parsed.data === "object", `${operation} returned no Peekaboo data`);
  return parsed;
}

function launchedIdentity(result, operation) {
  const parsed = parseCustomResult(result, operation);
  assert.ok(Number.isInteger(parsed.data.pid) && parsed.data.pid > 0, `${operation} returned no PID`);
  assert.ok(Array.isArray(parsed.data.window_ids) && parsed.data.window_ids.length > 0, `${operation} returned no window IDs`);
  return { pid: parsed.data.pid, windowIds: parsed.data.window_ids };
}

async function inspectWindow(client, pid, windowId, retries = 3) {
  let lastResult;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    lastResult = await client.callTool({
      name: "inspect_ui",
      arguments: { app_target: `PID:${pid}`, window_id: windowId },
    });
    if (
      !lastResult.isError &&
      !/AX tree incomplete|incomplete accessibility read/i.test(resultText(lastResult))
    ) return lastResult;
    if (
      !/snapshot is stale|receipt changed during traversal|AX tree incomplete|incomplete accessibility read/i.test(
        resultText(lastResult),
      )
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return assertToolSucceeded(lastResult, `inspect PID ${pid} window ${windowId}`);
}

async function listWindows(client, pid) {
  return resultText(
    assertToolSucceeded(
      await client.callTool({ name: "window", arguments: { action: "list", app: `PID:${pid}` } }),
      `list windows for PID ${pid}`,
    ),
  );
}

async function waitForNamedWindow(client, pid, title, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastList = "";
  while (Date.now() < deadline) {
    lastList = await listWindows(client, pid);
    try {
      return nativeWindowId(lastList, title);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert.fail(`Timed out waiting for PID ${pid} window containing ${JSON.stringify(title)}:\n${lastList}`);
}

async function quitOwnedProcess(client, pid) {
  await client.callTool({
    name: "app",
    arguments: { action: "quit", name: `PID:${pid}`, force: true },
  });
}

async function clickFreshNativeElement(client, pid, windowId, name, section = "button") {
  const inspection = await inspectWindow(client, pid, windowId);
  const text = resultText(inspection);
  const result = await client.callTool({
    name: "click",
    arguments: {
      snapshot: nativeSnapshotId(text),
      on: nativeElementId(text, name, section),
    },
  });
  if (result.isError) {
    assert.equal(result._meta?.mutation_dispatched, true, `click ${name} was rejected before dispatch`);
    assert.equal(result._meta?.requires_fresh_observation, true, `click ${name} did not request reinspection`);
    return result;
  }
  return assertToolSucceeded(result, `click ${name}`);
}

async function waitForFileContents(filePath, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await readFile(filePath, "utf8");
      if (last.includes(expected)) return last;
    } catch {
      // The save or move has not reached disk yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`Timed out waiting for ${filePath} to contain ${JSON.stringify(expected)}; last content: ${JSON.stringify(last)}`);
}

async function waitForDialog(client, pid, windowId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await client.callTool({
      name: "dialog",
      arguments: { action: "list", pid, window_id: windowId },
    });
    if (!lastResult.isError) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return assertToolSucceeded(lastResult, "observe TextEdit save dialog");
}

test(
  "native ControlMac performs semantic actions, exact-window work, dialogs, screenshots, and drag",
  { skip: gateReason("CONTROLMAC_RUN_NATIVE_SMOKE"), timeout: 180_000 },
  async (t) => {
    if (process.platform !== "darwin") {
      t.skip("native smoke tests require macOS");
      return;
    }
    if (!(await requireFile(t, peekabooPath, "pinned Peekaboo CLI"))) return;

    const nativePermissions = await readNativePeekabooPermissions();
    const accessibility = nativePermissions.find((permission) => permission.name === "Accessibility");
    if (!accessibility?.isGranted) {
      t.skip("missing required macOS permission: Accessibility");
      return;
    }
    const capturePermissions = await readCapturePeekabooPermissions();
    const screenRecording = capturePermissions.find((permission) => permission.name === "Screen Recording")?.isGranted === true;
    const eventSynthesizing = nativePermissions.find((permission) => permission.name === "Event Synthesizing")?.isGranted === true;

    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "controlmac-native-smoke-"));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
    const mcp = await connectMcp({ command: peekabooPath, args: peekabooMcpArgs });
    t.after(mcp.close);
    const captureMcp = await connectMcp({ command: peekabooPath, args: peekabooCaptureMcpArgs });
    t.after(captureMcp.close);
    const { tools } = await mcp.client.listTools();
    for (const name of ["app", "window", "inspect_ui", "click", "type", "set_value", "menu", "dialog"]) {
      toolByName(tools, name);
    }
    const { tools: captureTools } = await captureMcp.client.listTools();
    for (const name of ["see", "image"]) toolByName(captureTools, name);

    await t.test("Calculator click results and menu transitions are observed", async (st) => {
      const launch = launchedIdentity(
        await foregroundApp.execute(
          {
            action: "launch",
            app: "Calculator",
            new_instance: true,
            wait_ready: true,
            wait_for_window: true,
          },
          customToolContext(),
        ),
        "launch Calculator",
      );
      st.after(() => quitOwnedProcess(mcp.client, launch.pid));
      let windowId = launch.windowIds[0];

      assert.match(resultText(await inspectWindow(mcp.client, launch.pid, windowId)), /Application: Calculator/);
      for (const button of ["All Clear", "7", "Multiply", "6", "Equals"]) {
        await clickFreshNativeElement(mcp.client, launch.pid, windowId, button);
      }
      assert.match(
        resultText(await inspectWindow(mcp.client, launch.pid, windowId)),
        /value:\s*"[^"]*42"/,
        "Calculator did not visibly produce 42",
      );

      const menuList = assertToolSucceeded(
        await mcp.client.callTool({ name: "menu", arguments: { action: "list", app: `PID:${launch.pid}` } }),
        "list Calculator menus",
      );
      assert.match(resultText(menuList), /Scientific/);
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "menu",
          arguments: { action: "click", app: `PID:${launch.pid}`, path: "View > Scientific" },
        }),
        "select Calculator Scientific menu item",
      );
      windowId = nativeWindowId(await listWindows(mcp.client, launch.pid), "Calculator");
      assert.match(
        resultText(await inspectWindow(mcp.client, launch.pid, windowId)),
        /identifier: (?:Sine|InverseSine)/,
      );
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "menu",
          arguments: { action: "click", app: `PID:${launch.pid}`, path: "View > Basic" },
        }),
        "return Calculator to Basic",
      );
      windowId = nativeWindowId(await listWindows(mcp.client, launch.pid), "Calculator");
      assert.doesNotMatch(
        resultText(await inspectWindow(mcp.client, launch.pid, windowId)),
        /identifier: (?:Sine|InverseSine)/,
      );

      await st.test(
        "exact-window screenshot is a nonempty PNG",
        { skip: screenRecording ? false : "missing required macOS permission: Screen Recording" },
        async () => {
          const screenshotPath = path.join(temporaryRoot, "calculator.png");
          assertToolSucceeded(
            await captureMcp.client.callTool({
              name: "image",
              arguments: {
                app_target: `PID:${launch.pid}`,
                window_id: windowId,
                format: "png",
                path: screenshotPath,
              },
            }),
            "capture Calculator screenshot",
          );
          const image = await readFile(screenshotPath);
          assert.ok(image.length > 1_000, "Calculator screenshot is unexpectedly small");
          assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
          assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0, "PNG has invalid dimensions");
        },
      );
    });

    await t.test("TextEdit typing stays bound to exact duplicate windows and saves", async (st) => {
      const firstPath = path.join(temporaryRoot, `first-${Date.now()}.txt`);
      const secondPath = path.join(temporaryRoot, `second-${Date.now()}.txt`);
      await Promise.all([writeFile(firstPath, "first initial"), writeFile(secondPath, "second initial")]);
      const launch = launchedIdentity(
        await foregroundApp.execute(
          {
            action: "launch",
            app: "TextEdit",
            open_targets: [firstPath, secondPath],
            new_instance: true,
            wait_ready: true,
            wait_for_window: true,
          },
          customToolContext(),
        ),
        "launch isolated TextEdit fixtures",
      );
      st.after(() => quitOwnedProcess(mcp.client, launch.pid));
      const firstWindow = await waitForNamedWindow(mcp.client, launch.pid, path.basename(firstPath));
      const secondWindow = await waitForNamedWindow(mcp.client, launch.pid, path.basename(secondPath));
      assert.notEqual(firstWindow, secondWindow);

      const firstMarker = `first-bound-${Date.now()}`;
      parseCustomResult(
        await foregroundWindowFocus.execute(
          { pid: launch.pid, window_id: firstWindow },
          customToolContext(),
        ),
        "focus first TextEdit window before typing",
      );
      let inspection = resultText(await inspectWindow(mcp.client, launch.pid, firstWindow));
      let typeResult = await mcp.client.callTool({
        name: "type",
        arguments: {
          snapshot: nativeSnapshotId(inspection),
          on: nativeElementIdByIdentifier(inspection, "First Text View", "textField"),
          text: firstMarker,
          clear: true,
        },
      });
      if (typeResult.isError && typeResult._meta?.mutation_dispatched !== true) {
        const focusField = await mcp.client.callTool({
          name: "click",
          arguments: {
            snapshot: nativeSnapshotId(inspection),
            on: nativeElementIdByIdentifier(inspection, "First Text View", "textField"),
          },
        });
        assert.equal(focusField._meta?.mutation_dispatched, true, "TextEdit field focus was rejected before dispatch");
        inspection = resultText(await inspectWindow(mcp.client, launch.pid, firstWindow));
        typeResult = await mcp.client.callTool({
          name: "type",
          arguments: {
            snapshot: nativeSnapshotId(inspection),
            on: nativeElementIdByIdentifier(inspection, "First Text View", "textField"),
            text: firstMarker,
            clear: true,
          },
        });
      }
      if (typeResult.isError) {
        assert.equal(typeResult._meta?.mutation_dispatched, true, "TextEdit typing was rejected before dispatch");
        assert.equal(typeResult._meta?.requires_fresh_observation, true);
      }
      assert.match(resultText(await inspectWindow(mcp.client, launch.pid, firstWindow)), new RegExp(firstMarker));
      assert.doesNotMatch(resultText(await inspectWindow(mcp.client, launch.pid, secondWindow)), new RegExp(firstMarker));

      const secondMarker = `second-bound-${Date.now()}`;
      inspection = resultText(await inspectWindow(mcp.client, launch.pid, secondWindow));
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "set_value",
          arguments: {
            snapshot: nativeSnapshotId(inspection),
            on: nativeElementIdByIdentifier(inspection, "First Text View", "textField"),
            value: secondMarker,
          },
        }),
        "set second TextEdit window value",
      );
      assert.match(resultText(await inspectWindow(mcp.client, launch.pid, secondWindow)), new RegExp(secondMarker));
      assert.doesNotMatch(resultText(await inspectWindow(mcp.client, launch.pid, firstWindow)), new RegExp(secondMarker));

      parseCustomResult(
        await foregroundWindowFocus.execute(
          { pid: launch.pid, window_id: firstWindow },
          customToolContext(),
        ),
        "focus first TextEdit window",
      );
      await inspectWindow(mcp.client, launch.pid, firstWindow);
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "menu",
          arguments: { action: "click", app: `PID:${launch.pid}`, path: "File > Save" },
        }),
        "save first TextEdit window",
      );
      await waitForFileContents(firstPath, firstMarker);
    });

    await t.test("TextEdit save dialog writes the selected file", async (st) => {
      const sourcePath = path.join(temporaryRoot, `dialog-source-${Date.now()}.txt`);
      await writeFile(sourcePath, "dialog source", "utf8");
      const launch = launchedIdentity(
        await foregroundApp.execute(
          {
            action: "open",
            app: "TextEdit",
            open_targets: [sourcePath],
            new_instance: true,
            wait_ready: true,
            wait_for_window: true,
          },
          customToolContext(),
        ),
        "launch TextEdit save fixture",
      );
      st.after(() => quitOwnedProcess(mcp.client, launch.pid));

      const documentWindow = await waitForNamedWindow(
        mcp.client,
        launch.pid,
        path.basename(sourcePath),
      );
      parseCustomResult(
        await foregroundWindowFocus.execute(
          { pid: launch.pid, window_id: documentWindow },
          customToolContext(),
        ),
        "focus untitled TextEdit window",
      );
      await inspectWindow(mcp.client, launch.pid, documentWindow);

      const marker = `saved-dialog-${Date.now()}`;
      const documentInspection = resultText(await inspectWindow(mcp.client, launch.pid, documentWindow));
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "set_value",
          arguments: {
            snapshot: nativeSnapshotId(documentInspection),
            on: nativeElementIdByIdentifier(documentInspection, "First Text View", "textField"),
            value: marker,
          },
        }),
        "set save-dialog document value",
      );
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "menu",
          arguments: { action: "click", app: `PID:${launch.pid}`, path: "File > Save As…" },
        }),
        "open TextEdit Save As dialog",
      );
      await waitForDialog(mcp.client, launch.pid, documentWindow);

      const savedStem = `dialog-${Date.now()}`;
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "dialog",
          arguments: {
            action: "input",
            app: `PID:${launch.pid}`,
            window_id: documentWindow,
            field_index: 0,
            text: savedStem,
            clear: true,
          },
        }),
        "set exact TextEdit Save As filename in the current directory",
      );
      const dialogAfterInput = await inspectWindow(mcp.client, launch.pid, documentWindow);
      assert.match(resultText(dialogAfterInput), new RegExp(savedStem));
      assertToolSucceeded(
        await mcp.client.callTool({
          name: "dialog",
          arguments: {
            action: "click",
            app: `PID:${launch.pid}`,
            window_id: documentWindow,
            button: "Save",
          },
        }),
        "confirm exact TextEdit Save As dialog",
      );
      const savedName = `${savedStem}.txt`;
      await waitForFileContents(path.join(temporaryRoot, savedName), marker);
      assert.match(await listWindows(mcp.client, launch.pid), new RegExp(savedStem));
    });

    await t.test(
      "Finder drag moves a fixture file and is verified after reinspection",
      {
        skip:
          !screenRecording
            ? "missing required macOS permission: Screen Recording"
            : !eventSynthesizing
              ? "missing action-specific macOS permission: Event Synthesizing"
              : false,
      },
      async (st) => {
        const dragRoot = path.join(temporaryRoot, `drag-${Date.now()}`);
        const destinationName = "destination";
        const sourceName = `controlmac-source-${Date.now()}.txt`;
        const destinationPath = path.join(dragRoot, destinationName);
        const sourcePath = path.join(dragRoot, sourceName);
        await mkdir(destinationPath, { recursive: true });
        await writeFile(sourcePath, "drag fixture\n", "utf8");

        const opened = launchedIdentity(
          await foregroundApp.execute(
            {
              action: "open",
              app: "Finder",
              open_targets: [dragRoot],
              wait_ready: true,
              wait_for_window: true,
            },
            customToolContext(),
          ),
          "open Finder drag fixture",
        );
        const finderWindow = await waitForNamedWindow(mcp.client, opened.pid, path.basename(dragRoot));
        st.after(() =>
          mcp.client.callTool({
            name: "window",
            arguments: { action: "close", app: `PID:${opened.pid}`, window_id: finderWindow },
          }),
        );

        const seen = assertToolSucceeded(
          await mcp.client.callTool({
            name: "inspect_ui",
            arguments: { app_target: `PID:${opened.pid}`, window_id: finderWindow },
          }),
          "observe Finder drag fixture",
        );
        const seenText = resultText(seen);
        const dragResult = parseCustomResult(
          await foregroundDrag.execute(
            {
              app: `PID:${opened.pid}`,
              window_id: finderWindow,
              snapshot: nativeSnapshotId(seenText),
              from: nativeElementId(seenText, sourceName),
              to: nativeElementId(seenText, destinationName),
              duration_ms: 600,
              steps: 24,
            },
            customToolContext(),
          ),
          "drag Finder fixture file",
        );
        assert.ok(
          dragResult.start && dragResult.end,
          `drag returned no resolved coordinates: ${JSON.stringify(dragResult)}`,
        );
        assertToolSucceeded(
          await mcp.client.callTool({
            name: "inspect_ui",
            arguments: { app_target: `PID:${opened.pid}`, window_id: finderWindow },
          }),
          "reinspect Finder after drag",
        );
        await access(path.join(destinationPath, sourceName));
        await assert.rejects(access(sourcePath), { code: "ENOENT" });
      },
    );
  },
);
