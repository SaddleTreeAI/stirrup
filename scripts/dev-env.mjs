/** Pure helpers for `scripts/dev.mjs`: port defaults, derived env, and which services to start. */

export const DEFAULT_PORTS = { web: 5173, api: 3100, supervisor: 7091 };

export const SERVICES = [
  "@rakazo/api",
  "@rakazo/worker",
  "@rakazo/web",
  "@rakazo/sandbox-supervisor",
];

const SUPERVISOR = "@rakazo/sandbox-supervisor";

/** Env vars that follow the effective web, API, and supervisor ports. */
export function portEnv({ web, api, supervisor }) {
  const webUrl = `http://127.0.0.1:${web}`;
  const apiUrl = `http://127.0.0.1:${api}`;
  return {
    WEB_PORT: String(web),
    WEB_ORIGIN: webUrl,
    BETTER_AUTH_URL: webUrl,
    API_PORT: String(api),
    API_URL: apiUrl,
    API_PROXY_TARGET: apiUrl,
    SUPERVISOR_PORT: String(supervisor),
    SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisor}`,
  };
}

/**
 * Effective ports for this run: an explicit setting wins, otherwise a chosen free block,
 * otherwise the package defaults (web 5173, API 3100, supervisor 7091).
 */
export function resolvePorts(setting, chosen) {
  return {
    web: Number(setting("WEB_PORT") ?? chosen?.web ?? DEFAULT_PORTS.web),
    api: Number(setting("API_PORT") ?? chosen?.api ?? DEFAULT_PORTS.api),
    supervisor: Number(
      setting("SUPERVISOR_PORT") ?? chosen?.supervisor ?? DEFAULT_PORTS.supervisor,
    ),
  };
}

/**
 * Derived port env with shell / `.env` values left alone: fill only keys the caller did not set.
 */
export function derivedEnv(setting, ports) {
  const out = {};
  for (const [key, value] of Object.entries(portEnv(ports))) {
    out[key] = setting(key) ?? value;
  }
  return out;
}

/**
 * Services turbo should start. The local Docker sandbox supervisor is skipped when
 * `SANDBOX_PROVIDER` is set to anything other than `docker` (case-insensitive), including
 * `fake`, `none`, remote providers, `desktop`, and host/cluster providers.
 */
export function servicesFor(setting) {
  const provider = (setting("SANDBOX_PROVIDER") ?? "").trim().toLowerCase();
  if (!provider || provider === "docker") return SERVICES;
  return SERVICES.filter((name) => name !== SUPERVISOR);
}

/** One-line notice when the supervisor is left out, or null when it still starts. */
export function supervisorSkipMessage(setting) {
  const raw = (setting("SANDBOX_PROVIDER") ?? "").trim();
  if (!raw || raw.toLowerCase() === "docker") return null;
  return `SANDBOX_PROVIDER=${raw}: not starting sandbox-supervisor`;
}
