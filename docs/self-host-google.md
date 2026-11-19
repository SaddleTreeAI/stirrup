# Google Workspace MCP (Gmail, Drive, Calendar)

Connect Stirrup to Google's remote Model Context Protocol servers so bots can use Gmail,
Drive and Calendar. Google's servers are in Developer Preview and need membership in the
[Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview).
This page is for a self-hosted operator who creates the OAuth client in their own Google Cloud
project. Copy-paste form values live in
[self-host-google-presets.json](./self-host-google-presets.json). Run the offline checker before
you touch Google's console:

```bash
node scripts/google-oauth-preflight.mjs --web-origin https://stirrup.examplefirm.com \
  --client-id 123456789012-example.apps.googleusercontent.com \
  --mode internal \
  --scopes "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events"
```

General MCP OAuth notes (manual clients, redirect URI, authorization parameters) are in
[Tools and integrations](./self-host-integrations.md#mcp-servers). Token and secret storage is
covered in [Self-host secrets](./self-host-secrets.md) and
[Content encryption](./content-encryption.md).

## Which path to choose

| Path                               | When                                                                                                                           | Verification                                                                                                                                | Token lifetime                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Customer-owned Internal client** | The Cloud project belongs to the customer's own Google Workspace organization, and only that organization's users will connect | None. Internal apps skip Google's verification                                                                                              | Refresh tokens do not expire after 7 days                                                                                                                                                        |
| **External client in Testing**     | Pilot or evaluation with a small allowlist (vendor-owned or customer-owned External project)                                   | None while Testing                                                                                                                          | Authorizations and refresh tokens expire after **7 days** (except requests that only use `openid` / `email` / `profile`). Cap of 100 test users                                                  |
| **Published, later verified**      | Public or multi-tenant use of sensitive / restricted scopes                                                                    | Brand verification, then sensitive / restricted scope review (and a security assessment when restricted scopes store or transmit user data) | After Publishing, the 7-day Testing expiry ends. Unverified published apps that request sensitive or restricted scopes still show the unverified-app screen and keep a lifetime cap of 100 users |

A Workspace admin can mark an OAuth client **Trusted** for their organization. That treats it as
internal for their users (no 100-user cap, no 7-day Testing expiry). Prefer the customer-owned
Internal path for production self-hosts inside one Workspace.

## Cloud setup (customer Internal path)

Enable only the APIs and MCP services you will use. Google documents the full set on
[Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers).
For Gmail, Drive and Calendar:

1. Create or pick a Google Cloud project owned by the customer's Workspace organization.
2. Enable the product APIs: Gmail API, Google Drive API, Google Calendar API
   (`gmail.googleapis.com`, `drive.googleapis.com`, `calendar-json.googleapis.com`).
3. Enable the MCP services: Gmail MCP API, Drive MCP API, Calendar MCP API
   (`gmailmcp.googleapis.com`, `drivemcp.googleapis.com`, `calendarmcp.googleapis.com`).
4. Open **Google Auth Platform → Branding**. If the platform is not configured yet, click
   **Get Started**.
   - **App name:** `Stirrup` (or a customer name such as `Example Firm Stirrup`).
   - Choose a user support email, then continue.
5. On **Audience**, select **Internal**. (If Internal is unavailable, the project is not under a
   Workspace organization; use External + Testing for a pilot, and expect the 7-day expiry.)
6. On **Data Access → Add or Remove Scopes**, paste the scopes you need (see the presets file).
   MCP defaults:
   - Gmail: `gmail.readonly`, `gmail.compose`, `gmail.modify`
   - Drive: `drive.readonly`, `drive.file`
   - Calendar: `calendar.calendarlist.readonly`, `calendar.events.freebusy`,
     `calendar.events.readonly`, `calendar.events`
7. Open **Clients → Create client**.
   - Application type: **Web application**.
   - Name: `Stirrup` (or the customer's chosen name).
   - **Authorized redirect URIs:** add exactly
     `https://<your-web-host>/mcp/oauth/callback` (the Redirect URI shown in Stirrup's MCP server
     form). No trailing slash on the origin.
   - Tick **Use this client for an AI-powered agent**. Google rejects MCP requests from clients
     without this setting.
   - Create the client and copy the client ID and client secret.

Request offline access (`access_type=offline`) so Google issues a refresh token. Without it, Web
application clients prompt again about every hour.

## DNS and TLS for an on-prem hostname

Google's redirect URI rules require HTTPS except for `localhost` (and localhost IP addresses).
Hosts cannot be raw IP addresses (non-localhost). The host's TLD must be on the
[public suffix list](https://publicsuffix.org/). So:

- Rejected: `https://stirrup.corp.local`, `http://192.168.1.20`, `http://stirrup.examplefirm.com`
- Accepted: `https://stirrup.examplefirm.com` even when the name resolves only on the internal
  network (the redirect runs in the user's browser)
- Local workstation only: `http://localhost:5173` (and the matching port you open Stirrup on)

For an on-prem install, use a real domain the customer controls, an internal DNS A/AAAA (or CNAME)
record pointing at the host, and a certificate from the customer's CA or a DNS-01 ACME issue.
Set `WEB_ORIGIN` (and related auth URLs) to that HTTPS origin; see
[Self-hosting](./self-host.md) and [MCP OAuth redirect mismatch](./troubleshooting.md#mcp-oauth-redirect-mismatch).

Run the preflight script with that origin before creating the Google client so
`redirect_uri_mismatch` is caught offline.

## Add the three servers in Stirrup

For each of Gmail, Drive and Calendar (values in
[self-host-google-presets.json](./self-host-google-presets.json)):

1. Open **Settings → MCP servers** and add a **remote** server.
2. Paste the server URL (`https://gmailmcp.googleapis.com/mcp/v1`,
   `https://drivemcp.googleapis.com/mcp/v1`, or `https://calendarmcp.googleapis.com/mcp/v1`).
3. Under **Advanced**, enter the OAuth client ID and secret from the Cloud console.
4. Set **Scopes** to the space-separated list for that server.
5. Set **Authorization parameters** to `access_type=offline&prompt=consent` so Google issues
   (and re-issues) a refresh token.
6. Confirm the **Redirect URI** shown in the form matches the URI registered on the client.
7. Save, then click **Connect OAuth** and finish the Google consent screen.

Google does not support dynamic client registration for these servers; the operator-created client
is required. Stirrup stores the client and tokens in the encrypted MCP credential blob.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                 | What to do                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`                                  | Registered URI ≠ Stirrup's callback                                                          | Register exactly `<WEB_ORIGIN>/mcp/oauth/callback`. Origin must be HTTPS (unless localhost), not a raw IP, not a `.local` / private TLD. Re-run the preflight script |
| `access_denied` / admin policy                           | Workspace API controls or app access policy                                                  | Ask a Workspace admin to allow the client (or mark it Trusted) under API controls                                                                                    |
| `invalid_grant` after about a week                       | External app still in **Testing**                                                            | Publish the app, switch to Internal, or have an admin mark the client Trusted. Testing authorizations expire after 7 days                                            |
| "This app is blocked"                                    | Workspace blocks the app or the requested services                                           | Admin must allow the OAuth client / Google services for those users                                                                                                  |
| MCP requests rejected after a successful sign-in         | **Use this client for an AI-powered agent** not ticked                                       | Edit the client in Google Auth Platform → Clients and enable the AI-agent setting, or create a new Web application client with it selected                           |
| Refresh token stops after a password change              | Google revokes refresh tokens that include Gmail scopes when the user changes their password | User reconnects OAuth in Stirrup                                                                                                                                     |
| Older connections stop working without a password change | 100 refresh tokens per Google Account per OAuth client                                       | Avoid re-consent loops; disconnect unused clients; reconnect the affected user                                                                                       |
| Hourly sign-in prompts                                   | No refresh token (missing offline access)                                                    | Set authorization parameters to `access_type=offline&prompt=consent` and reconnect                                                                                   |

## Data handling

- OAuth state, tokens and the operator's client ID/secret live in the encrypted MCP credential
  blob ([content encryption](./content-encryption.md),
  [self-host secrets](./self-host-secrets.md)).
- Tool results (mail, files, calendar data) are sent to whichever model provider the bots use.
  A deployment that needs on-prem confidentiality must use a local model provider.
- Google's own guidance: untrusted email and documents can carry prompt-injection instructions.
  Keep human approval on send, delete and share tools, and treat tool output as untrusted input
  to the model.
