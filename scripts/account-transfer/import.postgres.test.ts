import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asSystem, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AccountTransferBundle, BundleTable, ColumnShape } from "./bundle.js";
import { bundleManifestHash } from "./bundle.js";
import { fingerprint, sealForRecipient, toJsonValue } from "./crypto.js";
import { importBundle } from "./import.js";
import { TABLE_COLUMNS } from "./policy.js";
import { schemaMetadata } from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll("-", "");
const userId = `account-transfer-${suffix}`;
const organizationId = `account-transfer-${suffix}`;
const spaceId = `account-transfer-${suffix}`;
const memberId = `account-transfer-${suffix}`;
const spaceMemberId = `account-transfer-${suffix}`;
const botId = `account-transfer-${suffix}`;
const groupId = `account-transfer-${suffix}`;
const botThreadId = `account-transfer-bot-thread-${suffix}`;
const groupThreadId = `account-transfer-group-thread-${suffix}`;
const taskId = `account-transfer-task-${suffix}`;
const runId = `account-transfer-run-${suffix}`;
const messageId = `account-transfer-message-${suffix}`;
const tempDirPromise = mkdtemp(path.join(os.tmpdir(), "account-transfer-postgres-"));
const db = databaseUrl ? createDb(databaseUrl) : undefined;
const system = db ? asSystem(db.prisma) : undefined;

function columnShape(
  name: string,
  source: Awaited<ReturnType<typeof schemaMetadata>>["allColumns"],
): ColumnShape {
  const column = source.find((candidate) => candidate.name === name);
  if (!column) throw new Error(`Test column missing: ${name}`);
  return column;
}

describePostgres("account-transfer real PostgreSQL import", () => {
  afterAll(async () => {
    if (!system || !db) return;
    await runAsSystem("clean account-transfer postgres fixture", async () => {
      await db.pool.query(`DELETE FROM space_keys WHERE "spaceId"=$1`, [spaceId]);
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: userId } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(await tempDirPromise, { recursive: true, force: true });
  });

  it("imports non-empty rows with composite keys and rewrapped Space keys", async () => {
    if (!system || !db || !databaseUrl) throw new Error("PostgreSQL fixture was not enabled");
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("ENCRYPTION_KEY", `transfer-fixture-${suffix}-encryption-key`);
    const user = await system.user.create({
      data: { id: userId, name: "Transfer fixture", email: `${suffix}@rakazo.test` },
    });
    const organization = await system.organization.create({
      data: {
        id: organizationId,
        name: "Transfer fixture",
        slug: `transfer-${suffix}`,
        createdAt: new Date(),
      },
    });
    const member = await system.member.create({
      data: { id: memberId, organizationId, userId, role: "owner", createdAt: new Date() },
    });
    const space = await system.space.create({
      data: {
        id: spaceId,
        organizationId,
        name: "Transfer fixture",
        isDefault: true,
        createdByUserId: userId,
      },
    });
    const spaceMember = await system.spaceMember.create({
      data: {
        id: spaceMemberId,
        spaceId,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const roleChoice = await system.spaceModelRoleChoice.create({
      data: {
        spaceId,
        userId,
        role: "default",
        position: 0,
        provider: "openrouter",
        modelId: "fixture-model",
        thinkingLevel: null,
        credentialId: null,
      },
    });
    await system.bot.create({
      data: { id: botId, spaceId, userId, name: "Transfer bot", color: "blue" },
    });
    await system.chatGroup.create({
      data: { id: groupId, spaceId, userId, name: "Transfer group" },
    });
    await system.chatGroupMember.create({ data: { id: `group-member-${suffix}`, groupId, botId } });
    await system.thread.create({ data: { id: botThreadId, spaceId, botId, userId } });
    await system.thread.create({ data: { id: groupThreadId, spaceId, groupId, userId } });
    await system.task.create({
      data: {
        id: taskId,
        spaceId,
        botId,
        threadId: botThreadId,
        userId,
        prompt: "A transferred task",
        status: "completed",
      },
    });
    await system.run.create({
      data: {
        id: runId,
        spaceId,
        botId,
        threadId: botThreadId,
        taskId,
        userId,
        status: "completed",
        trigger: "user",
      },
    });
    await system.message.create({
      data: {
        id: messageId,
        threadId: botThreadId,
        seq: 1,
        role: "assistant",
        blocks: [{ kind: "text", text: "Transferred reply" }],
        botId,
        runId,
      },
    });
    await system.run.update({ where: { id: runId }, data: { sourceMessageId: messageId } });
    const client = await db.pool.connect();
    let tables: AccountTransferBundle["tables"];
    const shapeFor = async (
      table: string,
      columns: string[],
      primaryKey: string[],
      row: Record<string, unknown>,
    ) => {
      const shape = await schemaMetadata(client, table);
      const selectedColumns = columns.map((name) => columnShape(name, shape.allColumns));
      return [
        table,
        {
          columns: selectedColumns,
          primaryKey,
          rows: [selectedColumns.map((column) => toJsonValue(row[column.name]))],
        } satisfies BundleTable,
      ] as const;
    };
    const shapeRowsFor = async (table: string, predicate: string, values: unknown[]) => {
      const shape = await schemaMetadata(client, table);
      const columns = TABLE_COLUMNS[table]!.map((name) => columnShape(name, shape.allColumns));
      const query = await client.query<Record<string, unknown>>(
        `SELECT ${columns.map((column) => `"${column.name}"`).join(",")} FROM "${table}" WHERE ${predicate}`,
        values,
      );
      return [
        table,
        {
          columns,
          primaryKey: shape.primaryKey,
          rows: query.rows.map((row) => columns.map((column) => toJsonValue(row[column.name]))),
        } satisfies BundleTable,
      ] as const;
    };
    try {
      const entries = await Promise.all([
        shapeFor(
          "user",
          ["id", "name", "email", "emailVerified", "createdAt", "updatedAt"],
          ["id"],
          user,
        ),
        shapeFor("organization", ["id", "name", "slug", "createdAt"], ["id"], organization),
        shapeFor("member", ["id", "organizationId", "userId", "role", "createdAt"], ["id"], member),
        shapeFor(
          "spaces",
          ["id", "organizationId", "name", "isDefault", "createdByUserId", "createdAt"],
          ["id"],
          space,
        ),
        shapeFor(
          "space_members",
          ["id", "spaceId", "organizationId", "userId", "role", "createdAt"],
          ["id"],
          spaceMember,
        ),
        shapeFor(
          "space_model_role_choices",
          [
            "spaceId",
            "userId",
            "role",
            "position",
            "provider",
            "modelId",
            "thinkingLevel",
            "credentialId",
          ],
          ["spaceId", "userId", "role", "position"],
          roleChoice,
        ),
        shapeRowsFor("bots", `"id"=$1`, [botId]),
        shapeRowsFor("chat_groups", `"id"=$1`, [groupId]),
        shapeRowsFor("chat_group_members", `"groupId"=$1`, [groupId]),
        shapeRowsFor("threads", `"id"=ANY($1::text[])`, [[botThreadId, groupThreadId]]),
        shapeRowsFor("tasks", `"id"=$1`, [taskId]),
        shapeRowsFor("runs", `"id"=$1`, [runId]),
        shapeRowsFor("messages", `"id"=$1`, [messageId]),
      ]);
      tables = Object.fromEntries(entries);
    } finally {
      client.release();
    }
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyFile = path.join(await tempDirPromise, "recipient-private.pem");
    const inputFile = path.join(await tempDirPromise, "transfer.json");
    await writeFile(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    const dataKey = Buffer.alloc(32, 7);
    const base = {
      version: 2 as const,
      purpose: "cutover" as const,
      bundleId: `bundle-${suffix}`,
      scope: {
        userId,
        organizationId,
        spaceId,
        botIds: [botId],
        mcpServerIds: [],
        credentialIds: [],
        connectionIds: [],
        spaceMemoryConfigIds: [],
        agentSecretIds: [],
        agentSkillIds: [],
        capabilityInstallIds: [],
        boardIds: [],
        sharedMemoryDocumentIds: [],
        botDeletionIds: [],
        excludedCredentialIds: [],
      },
      schemaFingerprint: fingerprint(Object.keys(tables)),
      tables,
      spaceKeys: [
        {
          id: `key-${suffix}`,
          spaceId,
          version: 1,
          envelope: sealForRecipient(
            pair.publicKey,
            dataKey,
            `space-key:key-${suffix}:${spaceId}:1`,
          ),
        },
      ],
      encryptedValues: [],
      omissions: { reconnectCredentialIds: [], inactiveRoutineIds: [], omittedTables: [] },
    };
    await writeFile(inputFile, JSON.stringify({ ...base, manifestHash: bundleManifestHash(base) }));

    // Remove the source fixture so the import exercises real inserts instead of conflicts.
    await system.organization.delete({ where: { id: organizationId } });
    await system.user.delete({ where: { id: userId } });
    await importBundle({ input: inputFile, privateKeyFile, dryRun: false });

    expect(await system.user.findUnique({ where: { id: userId } })).toMatchObject({
      email: `${suffix}@rakazo.test`,
    });
    expect(await system.member.findUnique({ where: { id: memberId } })).toMatchObject({
      role: "owner",
    });
    expect(await system.spaceMember.findUnique({ where: { id: spaceMemberId } })).toMatchObject({
      role: "owner",
    });
    expect(
      await system.spaceModelRoleChoice.findUnique({
        where: { spaceId_userId_role_position: { spaceId, userId, role: "default", position: 0 } },
      }),
    ).toMatchObject({ modelId: "fixture-model" });
    expect(await system.thread.findUnique({ where: { id: botThreadId } })).toMatchObject({
      botId,
      groupId: null,
    });
    expect(await system.thread.findUnique({ where: { id: groupThreadId } })).toMatchObject({
      botId: null,
      groupId,
    });
    expect(await system.task.findUnique({ where: { id: taskId } })).toMatchObject({
      threadId: botThreadId,
    });
    expect(await system.run.findUnique({ where: { id: runId } })).toMatchObject({
      threadId: botThreadId,
      taskId,
      sourceMessageId: messageId,
    });
    expect(await system.message.findUnique({ where: { id: messageId } })).toMatchObject({ runId });
    expect(
      (await db.pool.query(`SELECT "masterKeyId" FROM space_keys WHERE "spaceId"=$1`, [spaceId]))
        .rows[0]?.masterKeyId,
    ).toBeTruthy();
  });
});
