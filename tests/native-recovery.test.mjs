import assert from "node:assert/strict";
import test from "node:test";

import {
  assertToolSucceeded,
  connectMcp,
  gateReason,
  peekabooMcpArgs,
  peekabooPath,
  readNativePeekabooPermissions,
  requireFile,
  resultText,
  toolByName,
} from "./helpers.mjs";

test(
  "native control reports a stale target and can reobserve without replaying it",
  { skip: gateReason("CONTROLMAC_RUN_NATIVE_RECOVERY"), timeout: 30_000 },
  async (t) => {
    if (process.platform !== "darwin") {
      t.skip("native recovery tests require macOS");
      return;
    }
    if (!(await requireFile(t, peekabooPath, "pinned Peekaboo CLI"))) return;
    const permissions = await readNativePeekabooPermissions();
    const accessibility = permissions.find((permission) => permission.name === "Accessibility");
    if (!accessibility?.isGranted) {
      t.skip("missing required macOS permission: Accessibility");
      return;
    }

    const mcp = await connectMcp({ command: peekabooPath, args: peekabooMcpArgs });
    t.after(mcp.close);
    const { tools } = await mcp.client.listTools();
    toolByName(tools, "inspect_ui");
    toolByName(tools, "set_value");

    const before = assertToolSucceeded(
      await mcp.client.callTool({
        name: "inspect_ui",
        arguments: { app_target: "Finder" },
      }),
      "initial Finder inspection",
    );
    assert.ok(resultText(before).length > 0, "initial Finder inspection was empty");

    const rejected = await mcp.client.callTool({
      name: "set_value",
      arguments: {
        snapshot: `controlmac-missing-${Date.now()}`,
        on: "controlmac-element-that-does-not-exist",
        value: "must-not-be-delivered",
      },
    });
    assert.equal(rejected.isError, true, "an invalid snapshot/element pair was unexpectedly accepted");
    assert.match(resultText(rejected), /snapshot|element|not found|invalid|stale/i);

    const recovered = assertToolSucceeded(
      await mcp.client.callTool({
        name: "inspect_ui",
        arguments: { app_target: "Finder" },
      }),
      "fresh Finder inspection after stale target",
    );
    assert.ok(resultText(recovered).length > 0, "recovery inspection was empty");
  },
);
