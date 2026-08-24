import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNodeVersion,
  classifyOpenCodeVersion,
  renderHumanReport,
  sanitizeLogLine,
} from "../scripts/doctor.mjs";

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
