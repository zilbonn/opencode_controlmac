import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyChromeReadiness,
  classifyNodeVersion,
  classifyOpenCodeVersion,
  inspectChromeRemoteDebugging,
  renderHumanReport,
  sanitizeLogLine,
} from "../scripts/doctor.mjs";

test("Chrome probe distinguishes disabled debugging from a reachable stable endpoint", async (t) => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "controlmac-doctor-chrome-"));
  t.after(() => rm(temporaryHome, { recursive: true, force: true }));
  const paths = { homeDirectory: temporaryHome, chromeMcpPath: process.execPath };
  const options = { chromeAppPath: process.execPath };

  assert.deepEqual(await inspectChromeRemoteDebugging(paths, options), {
    mcpAvailable: true,
    ready: false,
    detail: "normal Google Chrome is not running with remote debugging enabled",
  });

  const activePortDirectory = path.join(
    temporaryHome,
    "Library/Application Support/Google/Chrome",
  );
  await mkdir(activePortDirectory, { recursive: true });
  await writeFile(
    path.join(activePortDirectory, "DevToolsActivePort"),
    "49152\n/devtools/browser/controlmac-test\n",
  );
  let requestedUrl;
  const ready = await inspectChromeRemoteDebugging(paths, {
    ...options,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        async json() {
          return {
            Browser: "Chrome/151.0.0.0",
            webSocketDebuggerUrl:
              "ws://127.0.0.1:49152/devtools/browser/controlmac-test",
          };
        },
      };
    },
  });
  assert.equal(requestedUrl, "http://127.0.0.1:49152/json/version");
  assert.deepEqual(ready, {
    mcpAvailable: true,
    ready: true,
    port: 49152,
    browser: "Chrome/151.0.0.0",
  });
});

test("Chrome readiness gives an actionable warning while normal Chrome is offline", () => {
  const result = classifyChromeReadiness({
    mcpAvailable: true,
    ready: false,
    detail: "normal Google Chrome is not running with remote debugging enabled",
  });

  assert.equal(result.status, "warn");
  assert.match(result.detail, /chrome:\/\/inspect\/#remote-debugging/);
  assert.match(result.detail, /enable remote debugging/);
  assert.match(result.detail, /restart OpenCode/);
  assert.match(result.detail, /list_pages/);
});

test("Chrome readiness reports a reachable normal Chrome session", () => {
  assert.deepEqual(
    classifyChromeReadiness({
      mcpAvailable: true,
      ready: true,
      port: 49152,
      browser: "Chrome/144.0.0.0",
    }),
    {
      status: "ok",
      detail:
        "Chrome/144.0.0.0 remote debugging is reachable at 127.0.0.1:49152; run list_pages and select the intended page",
    },
  );
});

test("Chrome readiness treats a missing MCP binary as an installation error", () => {
  assert.deepEqual(classifyChromeReadiness({ mcpAvailable: false, ready: false }), {
    status: "error",
    detail: "Chrome DevTools MCP executable is missing",
  });
});

test("Node support follows the declared release range", () => {
  assert.equal(classifyNodeVersion("v24.14.1").status, "error");
  assert.equal(classifyNodeVersion("v24.15.0").status, "ok");
  assert.equal(classifyNodeVersion("25.9.0").status, "error");
  assert.equal(classifyNodeVersion("v26.0.0").status, "ok");
  assert.equal(classifyNodeVersion("v27.1.2").status, "ok");
  assert.equal(classifyNodeVersion("not-a-version").status, "error");
});

test("OpenCode versions distinguish required, untested, old, and 2.x releases", () => {
  assert.deepEqual(classifyOpenCodeVersion("opencode 1.18.21\n"), {
    status: "ok",
    version: "1.18.21",
    detail: "1.18.21",
  });
  assert.equal(classifyOpenCodeVersion("1.18.20").status, "error");
  assert.equal(classifyOpenCodeVersion("OpenCode CLI v1.19.0").status, "warn");
  assert.equal(classifyOpenCodeVersion("2.0.0-beta.1").status, "error");
  assert.equal(classifyOpenCodeVersion("2.0.0").status, "error");
  assert.equal(classifyOpenCodeVersion("unknown").status, "error");
});

test("log sanitizer removes headers, URL credentials, query fields, and JSON secrets", () => {
  const fixtures = [
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["authorization=Custom-Scheme opaque-secret", "opaque-secret"],
    ["Cookie: sid=cookie-secret; theme=dark", "cookie-secret"],
    ["Set-Cookie: sid=set-cookie-secret; HttpOnly", "set-cookie-secret"],
    ["X-API-Key: header-api-secret", "header-api-secret"],
    ["API key = phrase-api-secret", "phrase-api-secret"],
    ["client_secret=client-secret-value", "client-secret-value"],
    ["https://alice:url-password@example.test/path", "alice:url-password"],
    [
      "https://example.test/?access_token=query-token&password=query-password&safe=yes",
      "query-token",
    ],
    [
      '{"authorization":"Bearer json-auth","cookie":"sid=json-cookie","apiKey":"json-key","clientSecret":"json-client","password":"json-password","safe":"visible"}',
      "json-auth",
    ],
  ];

  for (const [line, secret] of fixtures) {
    const sanitized = sanitizeLogLine(line);
    assert.ok(!sanitized.includes(secret), `${secret} survived in: ${sanitized}`);
    assert.match(sanitized, /<redacted>/);
  }

  const json = sanitizeLogLine(
    '{"authorization":"Bearer json-auth","cookie":"sid=json-cookie","apiKey":"json-key","clientSecret":"json-client","password":"json-password","safe":"visible"}',
  );
  for (const secret of ["json-auth", "json-cookie", "json-key", "json-client", "json-password"]) {
    assert.ok(!json.includes(secret), `${secret} survived in: ${json}`);
  }
  assert.match(json, /"safe":"visible"/);

  const query = sanitizeLogLine(
    "https://example.test/?access_token=query-token&password=query-password&safe=yes",
  );
  assert.ok(!query.includes("query-token"));
  assert.ok(!query.includes("query-password"));
  assert.match(query, /safe=yes/);
});

test("human log output warns users to review excerpts before sharing", () => {
  const report = {
    ok: true,
    checks: [{ status: "ok", name: "fixture", detail: "ready" }],
    logs: [{ path: "/tmp/example.log", size: 12, tail: ["safe line"] }],
  };
  const output = renderHumanReport(report, true);
  assert.match(output, /WARNING: Log excerpts are local debugging data/);
  assert.match(output, /Review and redact them again before sharing/);
  assert.match(output, /safe line/);
  assert.doesNotMatch(renderHumanReport(report, false), /safe line/);
});
