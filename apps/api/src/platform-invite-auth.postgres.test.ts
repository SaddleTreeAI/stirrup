import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailEmulator, FakeSandboxProvider } from "@rakazo/adapters";
import { asSystem, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const adminDatabaseUrl =
  process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_MIGRATION_URL : undefined;
const describePostgres = databaseUrl ? describe : describe.skip;
const webOrigin = "http://127.0.0.1:5173";

describePostgres(
  "private-platform invitations and account activation (PostgreSQL)",
  { timeout: 120_000 },
  () => {
    const emailAddress = `platform-invite-${randomBytes(5).toString("hex")}@example.test`;
    const inviteToken = randomBytes(32).toString("base64url");
    const email = new EmailEmulator();
    let handles: AppHandles;
    let adminDb: ReturnType<typeof createDb>;
    let dataDir: string;
    let userId: string | undefined;
    let inviteId: string | undefined;
    const extraInviteIds: string[] = [];
    const extraEmails: string[] = [];
    let rlsTestRoleCreated = false;

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "rakazo-platform-invite-"));
      handles = await createApp({
        databaseUrl: databaseUrl!,
        dataDir,
        sandboxProvider: "fake",
        sandbox: new FakeSandboxProvider(),
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "false",
        signupAllowlist: "",
        webOrigin,
        authUrl: webOrigin,
        email,
      });
      adminDb = createDb(adminDatabaseUrl ?? databaseUrl!);
      await runAsSystem("enable isolated platform invite test mode", () =>
        handles.prisma.deploymentSettings.upsert({
          where: { id: "default" },
          create: { id: "default", platformMode: true },
          update: { platformMode: true },
        }),
      );
      const invite = await runAsSystem("create isolated platform invite test row", () =>
        handles.prisma.platformInvite.create({
          data: {
            email: emailAddress,
            name: "Invited Staff",
            kind: "provision",
            role: "member",
            tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
            createdByUserId: "platform-invite-test-operator",
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      );
      inviteId = invite.id;
      await runAsSystem("prepare least-privilege invite RLS assertion role", async () => {
        const admin = asSystem(adminDb.prisma);
        await admin.$executeRawUnsafe(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_invite_rls_test') THEN
          REVOKE ALL ON "platform_invites" FROM "platform_invite_rls_test";
          DROP ROLE "platform_invite_rls_test";
        END IF;
      END $$`);
        await admin.$executeRawUnsafe(
          'CREATE ROLE "platform_invite_rls_test" NOLOGIN NOSUPERUSER NOBYPASSRLS',
        );
        rlsTestRoleCreated = true;
        await admin.$executeRawUnsafe(
          'GRANT SELECT ON "platform_invites" TO "platform_invite_rls_test"',
        );
      });
    });

    afterAll(async () => {
      if (handles) {
        await runAsSystem("clean isolated platform invite test rows", async () => {
          if (userId) await handles.prisma.user.deleteMany({ where: { id: userId } });
          if (inviteId) await handles.prisma.platformInvite.deleteMany({ where: { id: inviteId } });
          if (extraEmails.length)
            await handles.prisma.user.deleteMany({ where: { email: { in: extraEmails } } });
          if (extraInviteIds.length)
            await handles.prisma.platformInvite.deleteMany({
              where: { id: { in: extraInviteIds } },
            });
        });
        await handles.stop();
      }
      if (adminDb) {
        if (rlsTestRoleCreated) {
          const admin = asSystem(adminDb.prisma);
          await admin.$executeRawUnsafe(
            'REVOKE ALL ON "platform_invites" FROM "platform_invite_rls_test"',
          );
          await admin.$executeRawUnsafe('DROP ROLE "platform_invite_rls_test"');
        }
        await adminDb.prisma.$disconnect();
        await adminDb.pool.end();
      }
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    });

    async function auth(path: string, body: object) {
      return handles.app.request(`/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: webOrigin },
        body: JSON.stringify(body),
      });
    }

    it("admits only the invited address, records consent, and still requires mailbox verification", async () => {
      const visibleRows = await handles.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE "platform_invite_rls_test"');
        await tx.$executeRawUnsafe("SET LOCAL app.user_id = 'ordinary-user'");
        await tx.$executeRawUnsafe("SET LOCAL app.rls_bypass = 'off'");
        return tx.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*)::bigint AS count FROM "platform_invites"`;
      });
      expect(visibleRows).toEqual([{ count: 0n }]);

      const stranger = await auth("/sign-up/email", {
        email: "stranger@example.test",
        password: "test-password-123",
        name: "Stranger",
      });
      expect(stranger.status).toBe(400);

      const wrongAddress = await auth("/sign-up/email", {
        email: "different-address@example.test",
        password: "test-password-123",
        name: "Invited Staff",
        platformInviteToken: inviteToken,
        platformMonitoringConsent: true,
      });
      expect(wrongAddress.status).toBe(400);

      const noConsent = await auth("/sign-up/email", {
        email: emailAddress,
        password: "test-password-123",
        name: "Invited Staff",
        platformInviteToken: inviteToken,
      });
      expect(noConsent.status).toBe(403);

      const created = await auth("/sign-up/email", {
        email: emailAddress,
        password: "test-password-123",
        name: "Invited Staff",
        platformInviteToken: inviteToken,
        platformMonitoringConsent: true,
        platformRole: "owner",
        platformMonthlyBudgetMicros: "999999999999",
        platformMonitoringAcceptedAt: "2000-01-01T00:00:00.000Z",
      });
      expect(created.status, await created.clone().text()).toBe(200);

      const system = asSystem(handles.prisma);
      const user = await system.user.findUniqueOrThrow({ where: { email: emailAddress } });
      userId = user.id;
      expect(user).toMatchObject({
        platformRole: "member",
        platformMonthlyBudgetMicros: 100000000n,
        emailVerified: false,
        platformMonitoringAcceptedAt: expect.any(Date),
      });
      expect(
        await system.platformInvite.findUniqueOrThrow({ where: { id: inviteId } }),
      ).toMatchObject({ acceptedByUserId: user.id, acceptedAt: expect.any(Date) });

      const replay = await auth("/sign-up/email", {
        email: `replay-${emailAddress}`,
        password: "test-password-123",
        name: "Replay",
        platformInviteToken: inviteToken,
        platformMonitoringConsent: true,
      });
      expect(replay.status).toBe(400);

      const verifyLink = email.sent
        .filter((message) => message.to === emailAddress)
        .map((message) => message.text.match(/https?:\/\/\S*verify-email\S*/)?.[0])
        .find(Boolean);
      expect(verifyLink).toBeDefined();
      const verifyUrl = new URL(verifyLink!);
      await handles.app.request(verifyUrl.pathname + verifyUrl.search);
      const signedIn = await auth("/sign-in/email", {
        email: emailAddress,
        password: "test-password-123",
      });
      expect(signedIn.status, await signedIn.clone().text()).toBe(200);
      expect(await system.spaceMember.count({ where: { userId: user.id } })).toBeGreaterThan(0);
    });

    it("rejects expired and revoked invitations and atomically consumes concurrent redemption", async () => {
      const createInvite = async (
        email: string,
        token: string,
        expiresAt: Date,
        revokedAt?: Date,
      ) => {
        extraEmails.push(email);
        const invite = await runAsSystem("create invite auth boundary fixture", () =>
          handles.prisma.platformInvite.create({
            data: {
              email,
              name: "Invited Staff",
              role: "member",
              tokenHash: createHash("sha256").update(token).digest("hex"),
              createdByUserId: "platform-invite-test-operator",
              expiresAt,
              revokedAt,
            },
          }),
        );
        extraInviteIds.push(invite.id);
        return token;
      };
      const expiredToken = await createInvite(
        `expired-${emailAddress}`,
        randomBytes(32).toString("base64url"),
        new Date(Date.now() - 1_000),
      );
      const revokedToken = await createInvite(
        `revoked-${emailAddress}`,
        randomBytes(32).toString("base64url"),
        new Date(Date.now() + 60_000),
        new Date(),
      );
      for (const [email, token] of [
        [`expired-${emailAddress}`, expiredToken],
        [`revoked-${emailAddress}`, revokedToken],
      ]) {
        const response = await auth("/sign-up/email", {
          email,
          password: "test-password-123",
          name: "Invited Staff",
          platformInviteToken: token,
          platformMonitoringConsent: true,
        });
        expect(response.status).toBe(400);
      }

      const concurrentEmail = `concurrent-${emailAddress}`;
      const concurrentToken = await createInvite(
        concurrentEmail,
        randomBytes(32).toString("base64url"),
        new Date(Date.now() + 60_000),
      );
      const results = await Promise.all([
        auth("/sign-up/email", {
          email: concurrentEmail,
          password: "test-password-123",
          name: "Invited Staff",
          platformInviteToken: concurrentToken,
          platformMonitoringConsent: true,
        }),
        auth("/sign-up/email", {
          email: concurrentEmail,
          password: "test-password-123",
          name: "Invited Staff",
          platformInviteToken: concurrentToken,
          platformMonitoringConsent: true,
        }),
      ]);
      expect(results.filter((response) => response.status === 200)).toHaveLength(1);
      const [userCount, invitation] = await runAsSystem(
        "verify concurrent invite redemption result",
        async () =>
          Promise.all([
            handles.prisma.user.count({ where: { email: concurrentEmail } }),
            handles.prisma.platformInvite.findUniqueOrThrow({
              where: { id: extraInviteIds.at(-1) },
              select: { acceptedAt: true, acceptedByUserId: true },
            }),
          ]),
      );
      expect(userCount).toBe(1);
      expect(invitation.acceptedAt).toBeInstanceOf(Date);
      expect(invitation.acceptedByUserId).toBeTruthy();
    });
  },
);
