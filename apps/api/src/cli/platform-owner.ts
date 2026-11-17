// One-time, explicit grant after the operator has created and verified the intended account.
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { createDb, recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { loadEnv } from "../env.js";
import { setupPlatformCompanySpace } from "../platform-company-space.js";

const [action, rawEmail, ...args] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
const companySpaceArg = args.length === 2 && args[0] === "--company-space" ? args[1] : undefined;
if (
  action !== "bootstrap" ||
  !email ||
  (args.length > 0 && !companySpaceArg) ||
  !email.includes("@")
) {
  process.stderr.write(
    "Usage: platform-owner.js bootstrap <verified-email> [--company-space <existing-space-id>]\n",
  );
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
try {
  await runAsSystem("bootstrap private platform owner", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rakazo:platform-owner'))`;
      const user = await tx.user.findUnique({
        where: { email },
        select: { id: true, emailVerified: true, deactivatedAt: true },
      });
      if (!user?.emailVerified || user.deactivatedAt)
        throw new Error("A verified, active account with that email is required");
      const owner = await tx.user.findFirst({
        where: { platformRole: "owner" },
        select: { id: true },
      });
      if (owner && owner.id !== user.id)
        throw new Error("A different platform owner already exists");
      if (!owner) await tx.user.update({ where: { id: user.id }, data: { platformRole: "owner" } });
      await tx.deploymentSettings.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          platformMode: true,
        },
        update: { platformMode: true },
      });
    });
    if (companySpaceArg)
      await setupPlatformCompanySpace(prisma, await userIdFor(email), companySpaceArg);
    await recordSecurityEvent({
      type: "platform.owner.bootstrapped",
      userId: (await txOwnerId(prisma, email)) ?? null,
      metadata: { source: "operator-cli" },
    });
  });
  process.stdout.write(
    companySpaceArg
      ? "Private platform owner bootstrapped and the selected Space adopted; registration is invite-only.\n"
      : "Private platform owner bootstrapped; registration is invite-only.\n",
  );
} finally {
  await prisma.$disconnect();
  await pool.end();
}

async function txOwnerId(database: typeof prisma, address: string) {
  return database.user
    .findUnique({ where: { email: address }, select: { id: true } })
    .then((user) => user?.id);
}

async function userIdFor(address: string) {
  const user = await prisma.user.findUnique({ where: { email: address }, select: { id: true } });
  if (!user) throw new Error("Bootstrapped owner account could not be found");
  return user.id;
}
