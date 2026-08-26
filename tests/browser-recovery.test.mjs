import assert from "node:assert/strict";
import test from "node:test";

import { startFixtureServer } from "./browser-fixture/server.mjs";
import {
  assertToolSucceeded,
  chromeMcpArgs,
  chromeMcpPath,
  connectMcp,
  gateReason,
  requireFile,
  resultText,
  selectedPageId,
  snapshotUid,
} from "./helpers.mjs";

test(
  "browser control recovers by taking a fresh snapshot after a rejected UID",
  { skip: gateReason("CONTROLMAC_RUN_BROWSER_RECOVERY"), timeout: 60_000 },
  async (t) => {
    if (process.platform !== "darwin") {
      t.skip("the configured normal Chrome connection is macOS-specific");
      return;
    }
    if (!(await requireFile(t, chromeMcpPath, "Chrome DevTools MCP"))) return;

    const fixture = await startFixtureServer();
    t.after(fixture.close);
    const mcp = await connectMcp({
      command: process.execPath,
      args: [chromeMcpPath, ...chromeMcpArgs],
      timeoutMs: 30_000,
    });
    let pageId;
    t.after(async () => {
      if (pageId !== undefined) {
        await mcp.client.callTool({ name: "close_page", arguments: { pageId } }).catch(() => {});
      }
      await mcp.close();
    });

    assertToolSucceeded(
      await mcp.client.callTool({ name: "list_pages", arguments: {} }),
      "verify the normal Chrome connection before recovery work",
    );

    const opened = assertToolSucceeded(
      await mcp.client.callTool({ name: "new_page", arguments: { url: fixture.baseUrl, timeout: 15_000 } }),
      "open recovery fixture",
    );
    pageId = selectedPageId(resultText(opened));

    assertToolSucceeded(
      await mcp.client.callTool({ name: "take_snapshot", arguments: {} }),
      "take snapshot before rejected UID",
    );

    const rejected = await mcp.client.callTool({
      name: "fill",
      arguments: { uid: "controlmac-stale-uid", value: "must-not-be-delivered" },
    });
    assert.equal(rejected.isError, true, "an invalid browser UID was unexpectedly accepted");
    assert.match(resultText(rejected), /uid|element|not found|stale|snapshot/i);

    const snapshot = resultText(
      assertToolSucceeded(
        await mcp.client.callTool({ name: "take_snapshot", arguments: {} }),
        "take fresh recovery snapshot",
      ),
    );
    const inputUid = snapshotUid(snapshot, "Message", "textbox");
    assert.notEqual(inputUid, "controlmac-stale-uid");
    assertToolSucceeded(
      await mcp.client.callTool({ name: "fill", arguments: { uid: inputUid, value: "recovered" } }),
      "fill from fresh snapshot",
    );

    const recovered = resultText(
      assertToolSucceeded(
        await mcp.client.callTool({ name: "take_snapshot", arguments: {} }),
        "verify recovered field state",
      ),
    );
    assert.match(recovered, /textbox "Message".*value="recovered"/i);
  },
);
