# Local development

You need Node.js 24.15.0 or newer in the 24.x line, or Node.js 26+; pnpm 12;
and Docker. Node.js 25.x is not supported.

```bash
git clone https://github.com/SaddleTreeAI/stirrup.git
cd stirrup
cp .env.example .env
```

Set `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` to two values from `openssl rand -hex 16`,
then put them in `DATABASE_MIGRATION_URL` and `DATABASE_URL`. The app connects as its own
`rakazo_app` login, which row-level security applies to; migrations run as the owner
([database roles](./self-host-configuration.md#database-roles)). Set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to
independent long random values. Docker sandboxes also need a dedicated
`SANDBOX_SUPERVISOR_TOKEN`. You can also set `OPENROUTER_API_KEY`, or connect a supported
model provider during onboarding.

For host-side development with Docker Desktop, set `SANDBOX_CONTROL_VIA_LOOPBACK=true`
in `.env`. The supervisor discovers Docker Desktop's user socket automatically;
`DOCKER_HOST` or `DOCKER_SOCKET` can override it for another Docker runtime.

Managed app catalogs are optional. Set `COMPOSIO_API_KEY` for Composio, or the
`PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, and `PIPEDREAM_PROJECT_ID` trio for Pipedream
Connect. Users can add an HTTPS MCP server or OpenAPI JSON document from **Integrations** without
enabling either managed catalog. Local (stdio) MCP servers are off until you set
`MCP_STDIO_ENABLED=true` and list their commands in `MCP_STDIO_ALLOWED_COMMANDS`; see
[Tools and integrations](./self-host-integrations.md). Connector credentials are encrypted on the server and are never
returned by the API.

```bash
pnpm install
pnpm sandbox:build
pnpm dev
```

`pnpm dev` uses the Postgres in `DATABASE_URL` when it accepts a connection. Otherwise it starts a
local `rakazo-dev-postgres` container with Docker, and every checkout reuses that one. It applies
migrations and generates the Prisma client before starting. A branch that adds migrations main
doesn't have gets its own database on the same server, copied from the shared one when possible,
so unmerged schema changes stay out of it. When the default ports are taken, for example by
another git worktree, it moves to the next free block and prints the URL. Set `WEB_PORT` and
`API_PORT` to choose ports yourself; the script still derives `WEB_ORIGIN`, `API_URL`,
`API_PROXY_TARGET`, and the supervisor URL from whichever ports are in effect, and leaves any of
those you already set alone. Set `SANDBOX_PROVIDER=fake` (or any non-`docker` provider) to skip
starting the local sandbox supervisor when you do not need Docker computers.

To try a checkout from your phone or another computer, install [Tailscale](https://tailscale.com)
on each device and set `RAKAZO_DEV_TAILNET=1` in `.env`. `pnpm dev` then serves the web app over
HTTPS at `https://<machine>.<tailnet>.ts.net:<web port>`, reachable only from devices on your
tailnet, and stops serving it when you quit. Sign in at that URL on every device, including the
one running it. The first run may ask you to turn on HTTPS certificates for your tailnet.

To keep keys in a secrets manager instead of `.env`, set `RAKAZO_DEV_RUN_WITH` to the command
that runs another with your secrets added, for example `op run --env-file=dev.env --` or
`infisical run --env=dev --projectId=<project> --`. `pnpm dev` then starts inside it, and the
values it adds win over `.env`.

To run Postgres from the Compose file instead, start it with the `postgres-host` overlay, which
publishes loopback `127.0.0.1:5433`, and point `DATABASE_URL` and `DATABASE_MIGRATION_URL` at it:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
```

Use a URI-safe `POSTGRES_PASSWORD` (`openssl rand -hex 16`). An existing `pgdata` volume keeps the
user, password, and database from first init, so keep those values in `.env`, or change them in
place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when the data is
disposable); `docker compose down -v` deletes all Postgres state.

Open the printed URL ([http://127.0.0.1:5173](http://127.0.0.1:5173) by default), create an account, connect a model, and create
your first stirrup.

For deployment, provider selection, backups, and upgrades, see the
[self-hosting guide](./self-host.md), [production deployment](./self-host-production.md),
[backup and restore](./self-host-backups.md), and [upgrading](./self-host-upgrading.md).
