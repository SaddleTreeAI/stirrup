// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

// One attorney, three synthetic cases, four bots each. Safe to run again.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createOrganizationWithDefaultSpace, createRepos } from "@rakazo/db";
import { lawRoleAvatar } from "../../shared/avatars.js";
import { LAW_CHAT_MODEL_ID, LAW_CHAT_PROVIDER } from "../constants.js";

export const LAW_SEED_EMAIL = "rowan.ellis@demonstration-defense.example";
const ATTORNEY = "Rowan Ellis";
const EDITION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MONOREPO_ROOT = path.resolve(EDITION_ROOT, "../..");
const ROOT = path.join(EDITION_ROOT, "seed/cases");

/** Firm-wide bots for General Stirrup — not attached to any case. */
const GENERAL_BOTS = [
  {
    spawnKey: "law:general:chief",
    name: "Chief",
    description: "Firm-wide questions outside a single case.",
    instructions:
      "You are Chief for Demonstration Defense. Help with firm-wide questions that are not tied to one open case. Do not give legal advice. When a question belongs to a specific matter, say which case bot should take it.",
  },
  {
    spawnKey: "law:general:something",
    name: "Something",
    description: "Catch-all helper for the firm workspace.",
    instructions:
      "You are Something for Demonstration Defense. Handle small firm workspace tasks that are not tied to one open case. Do not give legal advice. When a question belongs to a specific matter, say which case bot should take it.",
  },
] as const;

const ROLES = [
  {
    role: "manager",
    name: "Case Manager",
    description: "Keeps this case's questions and next steps.",
    instructions: (brief: string) =>
      `You are the Case Manager for one criminal defense matter. Answer only from this case's brief and the retrieved documents. Do not give legal advice. Do not use facts from any other case. If the record does not say it, say so.\n\nCase brief:\n${brief}`,
  },
  {
    role: "documents",
    name: "Documents Expert",
    description: "Reads this case's files.",
    instructions: (brief: string) =>
      `You are the Documents Expert. Answer from the retrieved case documents and quote short phrases from them. Do not give legal advice. Do not use another case.\n\nCase brief:\n${brief}`,
  },
  {
    role: "transcripts",
    name: "Transcripts Expert",
    description: "Reads this case's transcripts.",
    instructions: (brief: string) =>
      `You are the Transcripts Expert. Work from transcripts and recorded statements in this case. Quote short phrases. Do not give legal advice. Do not use another case.\n\nCase brief:\n${brief}`,
  },
  {
    role: "generator",
    name: "Legal Doc Generator",
    description: "Drafts documents for review.",
    instructions: (brief: string) =>
      `You are the Legal Doc Generator. Draft from this case only. Begin every draft with the line: SYNTHETIC DRAFT — NOT FOR FILING. Do not give legal advice. Do not cite a rule that is not in the record. Where authority is missing, write [counsel to add].\n\nCase brief:\n${brief}`,
  },
] as const;

export type SeedLawPlatformResult = {
  userId: string;
  spaceId: string;
  cases: string[];
};

/** Seed the synthetic attorney, cases, bots, and documents. Safe to run again. */
export async function seedLawPlatform(input: {
  loginFile: string;
  databaseUrl: string;
  quiet?: boolean;
}): Promise<SeedLawPlatformResult> {
  const { prisma, pool } = createDb(input.databaseUrl);
  const db = asSystem(prisma, "law platform seed");
  try {
    const password = existingPassword(input.loginFile) ?? randomBytes(18).toString("base64url");
    const userId = await ensureUser(db, password, !existsSync(input.loginFile));
    writeLogin(input.loginFile, password);
    const spaceId = await createOrganizationWithDefaultSpace(db, {
      userId,
      orgId: randomUUID(),
      name: "Demonstration Defense",
      slug: "demonstration-defense",
    });
    const repos = createRepos(db);
    const actor = { userId, spaceId, email: LAW_SEED_EMAIL, isDeploymentOwner: false };
    for (const general of GENERAL_BOTS) {
      await repos.createBot(actor, {
        name: general.name,
        description: general.description,
        instructions: general.instructions,
        notifyOnFinish: false,
        dailyCheckIns: false,
        fleetManagement: false,
        spawnKey: general.spawnKey,
        modelProvider: LAW_CHAT_PROVIDER,
        modelId: LAW_CHAT_MODEL_ID,
        thinkingLevel: "medium",
      });
    }
    const present = new Set(
      readdirSync(ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    const cases = ["ruiz", "ward", "nunez"].filter((slug) => present.has(slug));
    for (const [position, slug] of cases.entries()) {
      const dir = path.join(ROOT, slug);
      const brief = readFileSync(path.join(dir, "brief.txt"), "utf8").trim();
      const name = caseName(slug);
      const lawCase = await db.lawCase.upsert({
        where: { spaceId_slug: { spaceId, slug } },
        create: { id: randomUUID(), spaceId, slug, name, brief, position },
        update: { name, brief, position },
      });
      await db.lawCaseMember.upsert({
        where: { caseId_userId: { caseId: lawCase.id, userId } },
        create: { caseId: lawCase.id, userId },
        update: {},
      });
      for (const role of ROLES) {
        const spawnKey = `law:${slug}:${role.role}`;
        const bot = await repos.createBot(actor, {
          name: role.name,
          description: role.description,
          instructions: role.instructions(brief),
          notifyOnFinish: false,
          dailyCheckIns: false,
          fleetManagement: false,
          color: lawRoleAvatar(role.role),
          spawnKey,
          modelProvider: LAW_CHAT_PROVIDER,
          modelId: LAW_CHAT_MODEL_ID,
          thinkingLevel: "medium",
        });
        await db.lawCaseBot.upsert({
          where: { caseId_role: { caseId: lawCase.id, role: role.role } },
          create: { caseId: lawCase.id, role: role.role, botId: bot.id },
          update: {},
        });
      }
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".txt") || file === "brief.txt") continue;
        const title = file.replace(/\.txt$/, "").replaceAll("-", " ");
        const body = readFileSync(path.join(dir, file), "utf8").trim();
        const filename = libraryFilename(file);
        const existing = await db.lawDocument.findFirst({
          where: { caseId: lawCase.id, kind: "library", title },
          select: { id: true },
        });
        if (!existing) {
          await db.lawDocument.create({
            data: {
              id: randomUUID(),
              caseId: lawCase.id,
              title,
              filename,
              body,
              kind: "library",
              version: 1,
            },
          });
        } else {
          await db.lawDocument.update({
            where: { id: existing.id },
            data: { filename, body },
          });
        }
      }
      const draftTitle = `${name} intake memo`;
      const draftBody = `SYNTHETIC DRAFT — NOT FOR FILING\n\n# ${draftTitle}\n\nWorking notes for counsel. Edit and save to create a new version.\n`;
      const draft = await db.lawDocument.findFirst({
        where: { caseId: lawCase.id, kind: "review", title: draftTitle, version: 1 },
        select: { id: true },
      });
      if (!draft) {
        await db.lawDocument.create({
          data: {
            id: randomUUID(),
            caseId: lawCase.id,
            title: draftTitle,
            filename: `${slug}-intake-memo.md`,
            body: draftBody,
            kind: "review",
            version: 1,
          },
        });
      }
    }
    // Prefer Demonstration Defense over a newer empty organization on sign-in.
    await db.session.updateMany({
      where: { userId },
      data: { activeOrganizationId: spaceId },
    });
    if (!input.quiet) process.stdout.write(`Seeded ${cases.length} cases for ${LAW_SEED_EMAIL}.\n`);
    return { userId, spaceId, cases };
  } finally {
    await pool.end();
  }
}

async function ensureUser(db: PrismaClient, password: string, rotate: boolean): Promise<string> {
  const require = createRequire(path.join(MONOREPO_ROOT, "packages/auth/package.json"));
  const { hashPassword } = require("better-auth/crypto") as {
    hashPassword: (value: string) => Promise<string>;
  };
  const hash = await hashPassword(password);
  const existing = await db.user.findUnique({
    where: { email: LAW_SEED_EMAIL },
    select: { id: true },
  });
  if (existing) {
    if (rotate) {
      await db.account.updateMany({
        where: { userId: existing.id, providerId: "credential" },
        data: { password: hash },
      });
    }
    return existing.id;
  }
  const id = randomUUID();
  const now = new Date();
  await db.user.create({
    data: {
      id,
      name: ATTORNEY,
      email: LAW_SEED_EMAIL,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.account.create({
    data: {
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: hash,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

function existingPassword(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return /^password=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() || undefined;
}

function writeLogin(file: string, password: string) {
  writeFileSync(file, `email=${LAW_SEED_EMAIL}\npassword=${password}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function caseName(slug: string): string {
  const short = slug.slice(0, 1).toUpperCase() + slug.slice(1);
  return `Commonwealth v. ${short}`;
}

/** Demo library titles keep varied professional extensions for the file cards. */
function libraryFilename(file: string): string {
  const base = file.replace(/\.txt$/, "");
  if (base.includes("report") || base.includes("complaint") || base.includes("motion")) {
    return `${base}.pdf`;
  }
  if (base.includes("ping") || base.includes("photo") || base.includes("image")) {
    return `${base}.png`;
  }
  if (base.includes("transcript") || base.includes("statement")) {
    return `${base}.docx`;
  }
  return `${base}.txt`;
}

/** Refuse a login path inside the monorepo so the password file is never committed by accident. */
export function assertLoginFileOutsideRepo(loginFile: string, repoRoot = MONOREPO_ROOT): string {
  const resolved = path.resolve(loginFile);
  const root = path.resolve(repoRoot);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(
      `LAW_LOGIN_FILE must resolve outside the repository (got ${resolved}; repo root is ${root}).`,
    );
  }
  return resolved;
}

async function main() {
  loadRootEnv();
  const loginFile = process.env.LAW_LOGIN_FILE?.trim();
  if (!loginFile) throw new Error("Set LAW_LOGIN_FILE to a path outside the repository.");
  const resolvedLogin = assertLoginFileOutsideRepo(loginFile);
  const databaseUrl =
    process.env.DATABASE_MIGRATION_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Set DATABASE_URL.");
  await seedLawPlatform({ loginFile: resolvedLogin, databaseUrl });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
