import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyScope,
  modeMessages,
  runPreflight,
  SCOPE_TABLE_VERSION,
} from "../google-oauth-preflight.mjs";

const FAKE_CLIENT = "123456789012-example.apps.googleusercontent.com";

test("scope table version is pinned for review", () => {
  assert.equal(SCOPE_TABLE_VERSION, "2026-11-18");
});

test("origin table: https public host is ok and prints redirect URI", () => {
  const result = runPreflight({
    webOrigin: "https://stirrup.example.com",
    clientId: FAKE_CLIENT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.redirectUri, "https://stirrup.example.com/mcp/oauth/callback");
  assert.equal(
    result.findings.some((f) => f.level === "error"),
    false,
  );
});

test("origin table: raw LAN IP over http fails", () => {
  const result = runPreflight({ webOrigin: "http://192.168.1.5" });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.code === "origin_raw_ip"));
  assert.ok(result.findings.some((f) => f.code === "origin_not_https"));
});

test("origin table: .corp.local fails closed", () => {
  const result = runPreflight({ webOrigin: "https://stirrup.corp.local" });
  assert.equal(result.ok, false);
  const tld = result.findings.find((f) => f.code === "origin_tld");
  assert.ok(tld);
  assert.match(tld.message, /\.local/);
});

test("origin table: http localhost is ok", () => {
  const result = runPreflight({ webOrigin: "http://localhost:5173" });
  assert.equal(result.ok, true);
  assert.equal(result.redirectUri, "http://localhost:5173/mcp/oauth/callback");
});

test("origin table: trailing slash warns", () => {
  const result = runPreflight({ webOrigin: "https://x.example.com/" });
  assert.equal(result.ok, true);
  assert.ok(result.findings.some((f) => f.code === "origin_trailing_slash"));
  assert.equal(result.redirectUri, "https://x.example.com/mcp/oauth/callback");
});

test("origin table: unknown TLD fails closed with offline message", () => {
  const result = runPreflight({ webOrigin: "https://stirrup.example.museum" });
  assert.equal(result.ok, false);
  const tld = result.findings.find((f) => f.code === "origin_tld");
  assert.ok(tld);
  assert.match(tld.message, /Cannot verify TLD/);
});

test("client id must look like a Google Web client", () => {
  const bad = runPreflight({
    webOrigin: "https://stirrup.example.com",
    clientId: "not-a-google-client",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f) => f.code === "client_id_format"));
});

test("scope classification table", () => {
  assert.equal(classifyScope("https://www.googleapis.com/auth/gmail.readonly"), "restricted");
  assert.equal(classifyScope("https://www.googleapis.com/auth/gmail.compose"), "restricted");
  assert.equal(classifyScope("https://www.googleapis.com/auth/gmail.modify"), "restricted");
  assert.equal(classifyScope("https://www.googleapis.com/auth/gmail.send"), "sensitive");
  assert.equal(classifyScope("https://www.googleapis.com/auth/drive.file"), "non-sensitive");
  assert.equal(classifyScope("https://www.googleapis.com/auth/drive.readonly"), "restricted");
  assert.equal(classifyScope("https://www.googleapis.com/auth/calendar.events"), "sensitive");
  assert.equal(classifyScope("https://www.googleapis.com/auth/something.else"), "unknown");
});

test("mode messages cover verification and 7-day testing expiry", () => {
  const scopes = [
    {
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      class: /** @type {const} */ ("restricted"),
    },
    {
      scope: "https://www.googleapis.com/auth/calendar.events",
      class: /** @type {const} */ ("sensitive"),
    },
  ];
  const testing = modeMessages("testing", scopes);
  assert.equal(testing.length, 2);
  assert.match(testing[1], /7 days/);

  const internal = modeMessages("internal", scopes);
  assert.equal(internal.length, 2);
  assert.match(internal[0], /no Google verification/i);

  const published = modeMessages("published", scopes);
  assert.equal(published.length, 2);
  assert.match(published[0], /CASA|security assessment/i);
  assert.match(published[1], /100 users/i);
});

test("runPreflight wires mode messages and scope classes", () => {
  const result = runPreflight({
    webOrigin: "https://stirrup.example.com",
    mode: "testing",
    scopes:
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.scopes.map((s) => s.class),
    ["restricted", "non-sensitive"],
  );
  assert.match(result.modeMessages.join("\n"), /7 days/);
});
