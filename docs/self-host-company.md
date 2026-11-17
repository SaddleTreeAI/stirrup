# Single-company deployment

Run one private Stirrup instance for a company with operator-assigned administration, invite-only
registration, shared bots and centrally managed model API keys. This mode is optional; ordinary
self-hosted installations keep their existing account and workspace behavior.

## Bootstrap the owner

Create a regular account and verify its email first. Then run the explicit owner bootstrap from the
API container:

```bash
docker compose --env-file .env -f docker-compose.images.yml exec api \
  node dist/cli/platform-owner.js bootstrap owner@example.test
```

For a source checkout, use `-f infra/compose/docker-compose.yml`. The command enables company mode,
which closes public registration. It never chooses an owner based on signup order. For an existing
Space created by this owner, add `--company-space <space-id>` to adopt it without changing its ID,
encrypted content or history. Adoption requires that every current member already be an active,
email-verified platform account; non-owners must have accepted the monitoring notice. The owner
configures a new company Space from **Administration** if no existing Space is selected.

## Accounts, roles and oversight

Registration is invite-only. Owners and administrators can invite members; only an owner can create
a pending account or appoint an administrator. A pending account has no password until its recipient
activates it. Invitation and activation links expire after seven days, can be revoked or reissued,
and require email delivery. The recipient verifies their email, chooses their password and accepts
the workspace monitoring notice before joining. An invitation alone does not verify an email.

The roles are **Owner**, **Admin** and **Member**. The owner configures the company Space, provider
connections, budgets and roles. Admins can manage member accounts and view company usage; only the
owner can inspect bot content. Company membership and bot access require an active, verified account
and the required notice acceptance. Deactivated accounts lose access.

The owner can view all platform accounts, their usage and bot content across the instance, including
content in private Spaces. Content inspection is owner-only and recorded in the security audit log.
Tell staff about this access before inviting them; the monitoring notice records their acceptance.

## Shared bots and computers

Existing bots do not become visible to staff automatically. Owners and admins manage company bots;
the bot creator manages their own bot. Other members need an explicit per-bot **Use**, **Edit** or
**Manage** grant; higher levels include lower ones. **Use** permits work with the bot, **Edit** also
changes its configuration, and **Manage** also controls its access and lifecycle.

A computer shared by several bots has no separate per-person grant. A member needs the required bot
permission for every bot attached to that computer. A legacy shared computer can therefore be
unavailable to someone who has access to only some of its bots; use dedicated computers when
different bot audiences need different access.

## Company model providers and budgets

The owner configures a separate company provider connection with an API key, then grants each person
specific models. This is distinct from personal model connections: personal keys stay private and
their calls do not use the company budget. Subscription or OAuth credentials cannot be shared as a
company connection, including an owner's Codex subscription.

The initial per-person monthly company budget is $100 and the owner can change it. Each grant controls
whether its calls count toward that budget; the budget is shared across all counted company grants
for that person. Reservations use the model's declared context and output limits and the highest
catalog price tier. Actual reported or estimated costs are not clipped to the reservation. If the
provider's price or billing differs from the catalog, one call can take a person over budget and
later budgeted company calls are refused. This is not a provider-side spending limit.
