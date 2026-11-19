import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PORTS,
  derivedEnv,
  portEnv,
  resolvePorts,
  SERVICES,
  servicesFor,
} from "../dev-env.mjs";

const settingOf = (map) => (name) => map[name];

test("portEnv names the loopback origins from the effective ports", () => {
  assert.deepEqual(portEnv({ web: 5199, api: 5198, supervisor: 7099 }), {
    WEB_PORT: "5199",
    WEB_ORIGIN: "http://127.0.0.1:5199",
    BETTER_AUTH_URL: "http://127.0.0.1:5199",
    API_PORT: "5198",
    API_URL: "http://127.0.0.1:5198",
    API_PROXY_TARGET: "http://127.0.0.1:5198",
    SUPERVISOR_PORT: "7099",
    SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7099",
  });
});

test("resolvePorts: both WEB_PORT and API_PORT set", () => {
  assert.deepEqual(
    resolvePorts(settingOf({ WEB_PORT: "5199", API_PORT: "5198" }), {
      web: 5173,
      api: 3100,
      supervisor: 7091,
    }),
    { web: 5199, api: 5198, supervisor: 7091 },
  );
});

test("resolvePorts: only WEB_PORT set uses the API and supervisor defaults", () => {
  assert.deepEqual(resolvePorts(settingOf({ WEB_PORT: "5199" }), null), {
    web: 5199,
    api: DEFAULT_PORTS.api,
    supervisor: DEFAULT_PORTS.supervisor,
  });
});

test("resolvePorts: only API_PORT set uses the web and supervisor defaults", () => {
  assert.deepEqual(resolvePorts(settingOf({ API_PORT: "5198" }), null), {
    web: DEFAULT_PORTS.web,
    api: 5198,
    supervisor: DEFAULT_PORTS.supervisor,
  });
});

test("resolvePorts: neither set uses the chosen block", () => {
  assert.deepEqual(resolvePorts(settingOf({}), { web: 5183, api: 3110, supervisor: 7101 }), {
    web: 5183,
    api: 3110,
    supervisor: 7101,
  });
});

test("explicit WEB_ORIGIN wins over the derived loopback URL", () => {
  const ports = { web: 5199, api: 5198, supervisor: 7091 };
  const env = derivedEnv(
    settingOf({ WEB_ORIGIN: "https://app.example.test:5199", WEB_PORT: "5199" }),
    ports,
  );
  assert.equal(env.WEB_ORIGIN, "https://app.example.test:5199");
  assert.equal(env.API_PROXY_TARGET, "http://127.0.0.1:5198");
  assert.equal(env.BETTER_AUTH_URL, "http://127.0.0.1:5199");
});

test("servicesFor keeps the supervisor when SANDBOX_PROVIDER is unset or docker", () => {
  assert.deepEqual(servicesFor(settingOf({})), SERVICES);
  assert.deepEqual(servicesFor(settingOf({ SANDBOX_PROVIDER: "docker" })), SERVICES);
  assert.ok(SERVICES.includes("@rakazo/sandbox-supervisor"));
});

test("servicesFor skips the supervisor for fake (any case) and other non-docker providers", () => {
  const without = SERVICES.filter((name) => name !== "@rakazo/sandbox-supervisor");
  assert.deepEqual(servicesFor(settingOf({ SANDBOX_PROVIDER: "fake" })), without);
  assert.deepEqual(servicesFor(settingOf({ SANDBOX_PROVIDER: "FAKE" })), without);
  assert.deepEqual(servicesFor(settingOf({ SANDBOX_PROVIDER: "none" })), without);
  assert.deepEqual(servicesFor(settingOf({ SANDBOX_PROVIDER: "e2b" })), without);
  assert.deepEqual(servicesFor(settingOf({ SANDBOX_PROVIDER: "desktop" })), without);
});
