#!/usr/bin/env node
/**
 * Offline preflight for Google Workspace MCP OAuth against a self-hosted Stirrup
 * WEB_ORIGIN. No network calls. Exit 1 when a blocking problem is found.
 *
 * Usage:
 *   node scripts/google-oauth-preflight.mjs --web-origin <url> \
 *     [--client-id <id>] [--mode internal|testing|published] [--scopes "<space separated>"]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Scope classification table. Sourced from Google's per-product scope pages; last checked 2026-11-18. */
export const SCOPE_TABLE_VERSION = "2026-11-18";

/** @typedef {"non-sensitive" | "sensitive" | "restricted" | "unknown"} ScopeClass */

/** @type {Readonly<Record<string, ScopeClass>>} */
export const SCOPE_CLASS = Object.freeze({
  // Gmail — https://developers.google.com/workspace/gmail/api/auth/scopes
  "https://www.googleapis.com/auth/gmail.send": "sensitive",
  "https://www.googleapis.com/auth/gmail.readonly": "restricted",
  "https://www.googleapis.com/auth/gmail.compose": "restricted",
  "https://www.googleapis.com/auth/gmail.modify": "restricted",
  "https://www.googleapis.com/auth/gmail.metadata": "restricted",
  "https://mail.google.com/": "restricted",
  // Drive — https://developers.google.com/workspace/drive/api/guides/api-specific-auth
  "https://www.googleapis.com/auth/drive.file": "non-sensitive",
  "https://www.googleapis.com/auth/drive.appdata": "non-sensitive",
  "https://www.googleapis.com/auth/drive.appfolder": "non-sensitive",
  "https://www.googleapis.com/auth/drive": "restricted",
  "https://www.googleapis.com/auth/drive.readonly": "restricted",
  "https://www.googleapis.com/auth/drive.metadata": "restricted",
  "https://www.googleapis.com/auth/drive.metadata.readonly": "restricted",
  // Calendar MCP scopes — confirm class in Cloud console Data Access; treated as sensitive here.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly": "sensitive",
  "https://www.googleapis.com/auth/calendar.events.freebusy": "sensitive",
  "https://www.googleapis.com/auth/calendar.events.readonly": "sensitive",
  "https://www.googleapis.com/auth/calendar.events": "sensitive",
  "https://www.googleapis.com/auth/calendar.readonly": "sensitive",
});

/** TLDs this offline checker accepts without consulting the public suffix list. */
export const KNOWN_PUBLIC_TLDS = Object.freeze([
  "com",
  "org",
  "net",
  "edu",
  "gov",
  "io",
  "ai",
  "us",
  "co",
  "dev",
  "app",
]);

/** Private / LAN-style suffixes Google rejects (not on the public suffix list for OAuth). */
export const REJECTED_PRIVATE_TLDS = Object.freeze([
  "local",
  "lan",
  "internal",
  "corp",
  "home",
  "localdomain",
]);

export const GOOGLE_CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

/**
 * @typedef {{ level: "error" | "warn" | "info"; code: string; message: string }} Finding
 * @typedef {{
 *   ok: boolean;
 *   origin: string | null;
 *   redirectUri: string | null;
 *   findings: Finding[];
 *   scopes: Array<{ scope: string; class: ScopeClass }>;
 *   modeMessages: string[];
 * }} PreflightResult
 */

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLocalhostHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isIpHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // Compact IPv6 check: contains a colon and only hex/colon characters.
  if (host.includes(":") && /^[0-9a-fA-F:]+$/.test(host)) return true;
  return false;
}

/**
 * @param {string} hostname
 * @returns {{ ok: boolean; tld: string | null; reason?: string }}
 */
export function checkHostnameTld(hostname) {
  const host = hostname.toLowerCase();
  if (isLocalhostHost(host)) return { ok: true, tld: null };
  if (!host.includes(".")) {
    return {
      ok: false,
      tld: null,
      reason: "Host must include a dot and a public top-level domain (or be localhost).",
    };
  }
  const labels = host.split(".").filter(Boolean);
  const tld = labels[labels.length - 1] ?? "";
  if (REJECTED_PRIVATE_TLDS.includes(tld)) {
    return {
      ok: false,
      tld,
      reason: `Host TLD ".${tld}" is not on the public suffix list; Google rejects it for redirect URIs.`,
    };
  }
  if (KNOWN_PUBLIC_TLDS.includes(tld)) return { ok: true, tld };
  return {
    ok: false,
    tld,
    reason: `Cannot verify TLD ".${tld}" offline. Use a known public TLD (${KNOWN_PUBLIC_TLDS.join(", ")}) or confirm the host is on the public suffix list before registering the redirect URI.`,
  };
}

/**
 * @param {string} scope
 * @returns {ScopeClass}
 */
export function classifyScope(scope) {
  return SCOPE_CLASS[scope] ?? "unknown";
}

/**
 * @param {string | undefined} mode
 * @param {Array<{ scope: string; class: ScopeClass }>} scopes
 * @returns {string[]}
 */
export function modeMessages(mode, scopes) {
  const hasRestricted = scopes.some((s) => s.class === "restricted");
  const hasSensitive = scopes.some((s) => s.class === "sensitive" || s.class === "restricted");
  /** @type {string[]} */
  const lines = [];
  switch (mode) {
    case "internal":
      lines.push(
        "Mode internal: no Google verification or CASA assessment is required for users in the project's Workspace organization.",
      );
      lines.push(
        "Refresh tokens do not expire after 7 days for Internal apps; Workspace admins can still block the client.",
      );
      break;
    case "testing":
      lines.push(
        "Mode testing: up to 100 test users; consent shows a testing warning. No brand/scope verification yet.",
      );
      lines.push(
        "WARNING: authorizations and refresh tokens expire after 7 days in Testing (except openid/email/profile-only grants).",
      );
      break;
    case "published":
      if (hasRestricted) {
        lines.push(
          "Mode published with restricted scopes: brand verification, restricted-scope verification, and a security assessment (CASA) are required before the unverified-app screen and 100-user cap are lifted.",
        );
      } else if (hasSensitive) {
        lines.push(
          "Mode published with sensitive scopes: brand verification and sensitive-scope verification are required; restricted-scope CASA is not required for these scopes alone.",
        );
      } else {
        lines.push(
          "Mode published with only non-sensitive (or unknown) scopes: brand verification is still needed to show the app name without warnings.",
        );
      }
      lines.push(
        "Until verification finishes, sensitive/restricted grants keep the unverified-app screen and a lifetime cap of 100 users; the 7-day Testing expiry does not apply once Published.",
      );
      break;
    default:
      break;
  }
  return lines;
}

/**
 * @param {{
 *   webOrigin: string;
 *   clientId?: string;
 *   mode?: "internal" | "testing" | "published";
 *   scopes?: string;
 * }} input
 * @returns {PreflightResult}
 */
export function runPreflight(input) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string | null} */
  let origin = null;
  /** @type {string | null} */
  let redirectUri = null;

  const raw = input.webOrigin?.trim() ?? "";
  if (!raw) {
    findings.push({
      level: "error",
      code: "origin_missing",
      message: "Pass --web-origin <url> (Stirrup's WEB_ORIGIN).",
    });
  } else {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      findings.push({
        level: "error",
        code: "origin_unparseable",
        message: `WEB_ORIGIN does not parse as a URL: ${raw}`,
      });
      parsed = null;
    }
    if (parsed) {
      if (parsed.username || parsed.password) {
        findings.push({
          level: "error",
          code: "origin_userinfo",
          message: "WEB_ORIGIN must not include userinfo (user:pass@).",
        });
      }
      if (parsed.pathname !== "/" && parsed.pathname !== "") {
        findings.push({
          level: "error",
          code: "origin_has_path",
          message:
            "WEB_ORIGIN must be an origin only (no path). Stirrup appends /mcp/oauth/callback.",
        });
      }
      if (raw.endsWith("/") && parsed.pathname === "/") {
        findings.push({
          level: "warn",
          code: "origin_trailing_slash",
          message:
            "WEB_ORIGIN should omit a trailing slash. Stirrup builds <origin>/mcp/oauth/callback; register that exact string.",
        });
      }
      if (parsed.search || parsed.hash) {
        findings.push({
          level: "error",
          code: "origin_query_or_hash",
          message: "WEB_ORIGIN must not include a query string or fragment.",
        });
      }

      const host = parsed.hostname;
      const localhost = isLocalhostHost(host);
      if (parsed.protocol !== "https:" && !(localhost && parsed.protocol === "http:")) {
        findings.push({
          level: "error",
          code: "origin_not_https",
          message: localhost
            ? "Unexpected scheme for localhost; use http:// or https://."
            : "WEB_ORIGIN must use https (http is allowed only for localhost).",
        });
      }
      if (isIpHostname(host) && !localhost) {
        findings.push({
          level: "error",
          code: "origin_raw_ip",
          message:
            "Host cannot be a raw IP address. Use a DNS name under a public TLD (or localhost for a single workstation).",
        });
      } else {
        const tldCheck = checkHostnameTld(host);
        if (!tldCheck.ok && tldCheck.reason) {
          findings.push({
            level: "error",
            code: "origin_tld",
            message: tldCheck.reason,
          });
        }
      }

      origin = `${parsed.protocol}//${parsed.host}`;
      redirectUri = `${origin}${MCP_OAUTH_CALLBACK_PATH}`;
    }
  }

  if (input.clientId !== undefined && input.clientId !== "") {
    if (!GOOGLE_CLIENT_ID_RE.test(input.clientId)) {
      findings.push({
        level: "error",
        code: "client_id_format",
        message:
          "Client ID must match /^\\d+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$/ (Web application client from Google Cloud).",
      });
    }
  }

  const scopeList = (input.scopes ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((scope) => ({ scope, class: classifyScope(scope) }));

  for (const entry of scopeList) {
    if (entry.class === "unknown") {
      findings.push({
        level: "warn",
        code: "scope_unknown",
        message: `Scope not in the embedded table (${SCOPE_TABLE_VERSION}): ${entry.scope}. Confirm its class on the Cloud console Data Access page.`,
      });
    }
  }

  const mode = input.mode;
  if (mode && !["internal", "testing", "published"].includes(mode)) {
    findings.push({
      level: "error",
      code: "mode_invalid",
      message: "Mode must be internal, testing, or published.",
    });
  }
  const messages =
    mode && ["internal", "testing", "published"].includes(mode)
      ? modeMessages(mode, scopeList)
      : [];

  const ok = !findings.some((f) => f.level === "error");
  return { ok, origin, redirectUri, findings, scopes: scopeList, modeMessages: messages };
}

/**
 * @param {string[]} argv
 * @returns {{
 *   webOrigin?: string;
 *   clientId?: string;
 *   mode?: "internal" | "testing" | "published";
 *   scopes?: string;
 *   help?: boolean;
 *   error?: string;
 * }}
 */
export function parseArgs(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    const take = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        out.error = `Missing value for ${arg}`;
        return undefined;
      }
      return value;
    };
    if (arg === "--web-origin") out.webOrigin = take();
    else if (arg === "--client-id") out.clientId = take();
    else if (arg === "--mode") {
      const value = take();
      if (value) out.mode = /** @type {"internal" | "testing" | "published"} */ (value);
    } else if (arg === "--scopes") out.scopes = take();
    else {
      out.error = `Unknown argument: ${arg}`;
      break;
    }
  }
  return out;
}

/**
 * @param {PreflightResult} result
 * @param {{ log?: (line: string) => void }} [opts]
 */
export function printReport(result, opts = {}) {
  const log = opts.log ?? console.log;
  if (result.redirectUri) {
    log(`Redirect URI to register: ${result.redirectUri}`);
  }
  if (result.origin) {
    log(`Normalized WEB_ORIGIN: ${result.origin}`);
  }
  for (const finding of result.findings) {
    log(`${finding.level.toUpperCase()}: [${finding.code}] ${finding.message}`);
  }
  if (result.scopes.length > 0) {
    log(`Scope classes (table ${SCOPE_TABLE_VERSION}):`);
    for (const entry of result.scopes) {
      log(`  ${entry.class}\t${entry.scope}`);
    }
  }
  for (const line of result.modeMessages) {
    log(line);
  }
  if (result.ok) {
    log("Preflight OK.");
  } else {
    log(
      "Preflight failed. Fix the errors above before creating or updating the Google OAuth client.",
    );
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`Usage: node scripts/google-oauth-preflight.mjs --web-origin <url> [options]

Options:
  --client-id <id>     Google Web application client ID
  --mode <mode>        internal | testing | published
  --scopes "<list>"    Space-separated OAuth scopes
  --help               Show this help

Checks WEB_ORIGIN offline against Google's redirect URI rules, prints the exact
callback to register (<origin>/mcp/oauth/callback), classifies scopes, and
summarizes verification implications for the chosen mode. Exit code 1 on errors.`);
    return 0;
  }
  if (args.error) {
    console.error(`ERROR: ${args.error}`);
    return 1;
  }
  if (!args.webOrigin) {
    console.error("ERROR: --web-origin is required (or pass --help).");
    return 1;
  }
  const result = runPreflight({
    webOrigin: args.webOrigin,
    clientId: args.clientId,
    mode: args.mode,
    scopes: args.scopes,
  });
  printReport(result);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
