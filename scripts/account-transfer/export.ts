import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  contentKeyProviderFromEnv,
  EncryptedSecretStore,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core/secrets-guard";
import { createDb, runAsSystem } from "@rakazo/db";
import type { AccountTransferBundle, BundleTable, ColumnShape, ExportScope } from "./bundle.js";
import { BUNDLE_VERSION, bundleManifestHash } from "./bundle.js";
import { fingerprint, sealForRecipient } from "./crypto.js";
import { readBounded, serializePg, writePrivate } from "./io.js";
import { INTENTIONAL_OMISSIONS, TABLE_COLUMNS } from "./policy.js";
import type { PoolClient } from "./schema.js";
import {
  assertNoUnselectedInboundRows,
  capture,
  foreignKeyColumns,
  schemaMetadata,
} from "./schema.js";

function fieldIds(rows: Record<string, unknown>[], field: string): string[] {
  return [
    ...new Set(
      rows.map((row) => row[field]).filter((value): value is string => typeof value === "string"),
    ),
  ];
}

function referencedSecretIds(
  collected: Map<string, { rows: Record<string, unknown>[] }>,
): string[] {
  const ids = new Set<string>();
  for (const [table, { rows }] of collected) {
    for (const row of rows) {
      if (table === "bots" && typeof row.webhookSecretId === "string") ids.add(row.webhookSecretId);
      if (
        [
          "mcp_servers",
          "connections",
          "capability_installs",
          "space_memory_configs",
          "browser_profiles",
          "user_model_credentials",
          "agent_secrets",
        ].includes(table) &&
        typeof row.secretId === "string"
      )
        ids.add(row.secretId);
      if (table === "pages") {
        if (typeof row.secretId === "string") ids.add(row.secretId);
        if (typeof row.shareSecretId === "string") ids.add(row.shareSecretId);
      }
    }
  }
  return [...ids];
}

export async function keygen(privateFile: string, publicFile: string) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  await writePrivate(privateFile, privatePem);
  await writePrivate(publicFile, publicPem);
  process.stdout.write("Recipient keys created with owner-only file modes.\n");
}

export async function exportBundle(options: {
  output: string;
  publicKeyFile: string;
  scope: ExportScope;
  dryRun: boolean;
  rehearsalExport?: boolean;
  expectedSchemaFingerprint?: string;
  externalRefsOutput?: string;
}) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await unwrapEnvFromKeyManager();
  const publicKey = await readBounded(options.publicKeyFile, 16_384);
  const { prisma, pool, contentKeys } = createDb(process.env.DATABASE_URL, {
    applicationName: "account-transfer-source-read-only",
    keyProvider: contentKeyProviderFromEnv(),
    encryptContent: false,
  });
  const collected = new Map<
    string,
    { columns: ColumnShape[]; primaryKey: string[]; rows: Record<string, unknown>[] }
  >();
  const collect = async (
    client: PoolClient,
    table: string,
    predicate: string,
    values: unknown[],
  ) => {
    const result = await capture(client, table, predicate, values);
    if (result.rows.length) collected.set(table, result);
    return result.rows;
  };
  let targetBundle: AccountTransferBundle | undefined;
  try {
    await runAsSystem("selectively export one owner's bots and account data", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const [user] = await collect(client, "user", `"id"=$1`, [options.scope.userId]);
        const [organization] = await collect(client, "organization", `"id"=$1`, [
          options.scope.organizationId,
        ]);
        const members = await collect(client, "member", `"organizationId"=$1 AND "userId"=$2`, [
          options.scope.organizationId,
          options.scope.userId,
        ]);
        const [space] = await collect(client, "spaces", `"id"=$1 AND "organizationId"=$2`, [
          options.scope.spaceId,
          options.scope.organizationId,
        ]);
        const spaceMembers = await collect(
          client,
          "space_members",
          `"spaceId"=$1 AND "userId"=$2`,
          [options.scope.spaceId, options.scope.userId],
        );
        if (!user || !organization || members.length !== 1 || !space || spaceMembers.length !== 1)
          throw new Error(
            "Selected account, organization, and sole-member Space were not verified",
          );
        const orgMembers = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM member WHERE "organizationId"=$1`,
          [options.scope.organizationId],
        );
        const orgSpaces = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM spaces WHERE "organizationId"=$1`,
          [options.scope.organizationId],
        );
        if (orgMembers.rows[0]?.count !== "1" || orgSpaces.rows[0]?.count !== "1")
          throw new Error(
            "Selected organization is shared or has additional Spaces outside the transfer scope",
          );
        const allSpaceMembers = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM space_members WHERE "spaceId"=$1`,
          [options.scope.spaceId],
        );
        if (allSpaceMembers.rows[0]?.count !== "1")
          throw new Error("Selected Space has additional members outside the transfer scope");
        await collect(client, "account", `"userId"=$1 AND "password" IS NOT NULL`, [
          options.scope.userId,
        ]);
        const bots = await collect(
          client,
          "bots",
          `"spaceId"=$1 AND "userId"=$2 AND "id"=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, options.scope.botIds],
        );
        if (bots.length !== options.scope.botIds.length)
          throw new Error("A requested bot is missing or belongs to another account");
        if (
          bots.some(
            (row) => row.parentBotId && !options.scope.botIds.includes(String(row.parentBotId)),
          )
        )
          throw new Error("A selected bot has a parent outside the selected bot set");

        const candidateGroups = await client.query<{ id: string }>(
          `SELECT DISTINCT g."id" FROM chat_groups g JOIN chat_group_members gm ON gm."groupId"=g."id" WHERE g."spaceId"=$1 AND gm."botId"=ANY($2::text[])`,
          [options.scope.spaceId, options.scope.botIds],
        );
        const groupIds = candidateGroups.rows.map((row) => row.id);
        if (groupIds.length) {
          const memberships = await client.query<{ groupId: string; botId: string }>(
            `SELECT "groupId","botId" FROM chat_group_members WHERE "groupId"=ANY($1::text[])`,
            [groupIds],
          );
          if (memberships.rows.some((row) => !options.scope.botIds.includes(row.botId)))
            throw new Error("A selected group chat includes a bot outside the transfer scope");
          await collect(client, "chat_groups", `"id"=ANY($1::text[]) AND "spaceId"=$2`, [
            groupIds,
            options.scope.spaceId,
          ]);
          await collect(client, "chat_group_members", `"groupId"=ANY($1::text[])`, [groupIds]);
        }
        const sectionIds = [
          ...new Set([
            ...fieldIds(bots, "sectionId"),
            ...fieldIds(collected.get("chat_groups")?.rows ?? [], "sectionId"),
          ]),
        ];
        if (sectionIds.length)
          await collect(
            client,
            "bot_sections",
            `"id"=ANY($1::text[]) AND "spaceId"=$2 AND "userId"=$3`,
            [sectionIds, options.scope.spaceId, options.scope.userId],
          );

        const threadRows = await collect(
          client,
          "threads",
          `"spaceId"=$1 AND ("botId"=ANY($2::text[]) OR "helperBotId"=ANY($2::text[]) OR "groupId"=ANY($3::text[]))`,
          [options.scope.spaceId, options.scope.botIds, groupIds],
        );
        const threadIds = fieldIds(threadRows, "id");
        if (threadRows.some((row) => row.externalConversationId)) {
          const externalIds = fieldIds(threadRows, "externalConversationId");
          await collect(
            client,
            "external_conversations",
            `"id"=ANY($1::text[]) AND "spaceId"=$2 AND "botId"=ANY($3::text[])`,
            [externalIds, options.scope.spaceId, options.scope.botIds],
          );
          await collect(client, "external_messages", `"externalConversationId"=ANY($1::text[])`, [
            externalIds,
          ]);
        }
        if (threadIds.length) {
          await collect(
            client,
            "thread_reads",
            `"threadId"=ANY($1::text[]) AND "userId"=$2 AND "spaceId"=$3`,
            [threadIds, options.scope.userId, options.scope.spaceId],
          );
          await collect(client, "messages", `"threadId"=ANY($1::text[])`, [threadIds]);
          await collect(client, "events", `"threadId"=ANY($1::text[])`, [threadIds]);
        }
        await collect(client, "tasks", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "routines", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "runs", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        const selectedRunIds = fieldIds(collected.get("runs")?.rows ?? [], "id");
        if (selectedRunIds.length) {
          await collect(client, "attempts", `"runId"=ANY($1::text[])`, [selectedRunIds]);
          await collect(
            client,
            "steering_messages",
            `"runId"=ANY($1::text[]) AND "botId"=ANY($2::text[])`,
            [selectedRunIds, options.scope.botIds],
          );
        }
        await collect(
          client,
          "audit_events",
          `"organizationId"=$1 AND ("targetId"=ANY($2::text[]) OR "threadId"=ANY($3::text[]) OR "runId"=ANY($4::text[]))`,
          [options.scope.organizationId, options.scope.botIds, threadIds, selectedRunIds],
        );
        const botDeletions = await collect(
          client,
          "bot_deletions",
          `"spaceId"=$1 AND "deletedByUserId"=$2 AND id=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, options.scope.botDeletionIds],
        );
        if (botDeletions.length !== options.scope.botDeletionIds.length)
          throw new Error(
            "A selected deleted bot record is missing or outside the selected account",
          );
        await collect(client, "scratchpad_items", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "taught_skills", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "agent_homes", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "browser_profiles", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "agent_imports", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        const computerIds = fieldIds(bots, "computerId");
        if (computerIds.length) {
          await collect(client, "computers", `"id"=ANY($1::text[]) AND "spaceId"=$2`, [
            computerIds,
            options.scope.spaceId,
          ]);
          await collect(client, "computer_runs", `"spaceId"=$1 AND "computerId"=ANY($2::text[])`, [
            options.scope.spaceId,
            computerIds,
          ]);
        }
        await collect(
          client,
          "artifacts",
          `"spaceId"=$1 AND ("botId"=ANY($2::text[]) OR "groupId"=ANY($3::text[]))`,
          [options.scope.spaceId, options.scope.botIds, groupIds],
        );
        await collect(
          client,
          "pages",
          `"spaceId"=$1 AND ("botId"=ANY($2::text[]) OR "groupId"=ANY($3::text[]))`,
          [options.scope.spaceId, options.scope.botIds, groupIds],
        );
        const pageIds = fieldIds(collected.get("pages")?.rows ?? [], "id");
        if (pageIds.length)
          await collect(client, "page_versions", `"pageId"=ANY($1::text[])`, [pageIds]);
        await collect(client, "usage_records", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        const botAssignments = await collect(
          client,
          "bot_mcp_servers",
          `"spaceId"=$1 AND "botId"=ANY($2::text[])`,
          [options.scope.spaceId, options.scope.botIds],
        );
        const mcpIds = [
          ...new Set([...options.scope.mcpServerIds, ...fieldIds(botAssignments, "serverId")]),
        ];
        const selectedMcpRows = await collect(
          client,
          "mcp_servers",
          `"spaceId"=$1 AND "userId"=$2 AND "id"=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, mcpIds],
        );
        if (selectedMcpRows.length !== mcpIds.length)
          throw new Error("A selected MCP server is missing or belongs to another account");
        const spaceMemoryConfigs = await collect(
          client,
          "space_memory_configs",
          `"spaceId"=$1 AND "userId"=$2 AND id=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, options.scope.spaceMemoryConfigIds],
        );
        if (spaceMemoryConfigs.length !== options.scope.spaceMemoryConfigIds.length)
          throw new Error(
            "A selected Space memory configuration is missing or belongs to another account",
          );
        const connections = await collect(
          client,
          "connections",
          `"spaceId"=$1 AND "userId"=$2 AND id=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, options.scope.connectionIds],
        );
        if (connections.length !== options.scope.connectionIds.length)
          throw new Error("A selected connection is missing or belongs to another account");
        const capabilityIds = [
          ...new Set([
            ...options.scope.capabilityInstallIds,
            ...fieldIds(selectedMcpRows, "installId"),
          ]),
        ];
        const capabilityInstalls = await collect(
          client,
          "capability_installs",
          `"spaceId"=$1 AND "userId"=$2 AND id=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, capabilityIds],
        );
        if (capabilityInstalls.length !== capabilityIds.length)
          throw new Error(
            "A selected capability installation is missing or belongs to another account",
          );
        if (capabilityIds.length)
          await collect(
            client,
            "capability_install_spaces",
            `"installId"=ANY($1::text[]) AND "spaceId"=$2`,
            [capabilityIds, options.scope.spaceId],
          );
        const legacyMcp = mcpIds.length
          ? await client.query(
              `SELECT 1 FROM mcp_servers WHERE "spaceId"=$1 AND "userId"=$2 AND id=ANY($3::text[]) AND (args <> '[]'::jsonb OR env <> '{}'::jsonb OR files <> '{}'::jsonb OR headers <> '{}'::jsonb) LIMIT 1`,
              [options.scope.spaceId, options.scope.userId, mcpIds],
            )
          : { rowCount: 0 };
        if (legacyMcp.rowCount)
          throw new Error(
            "Legacy plaintext MCP arguments or headers must be migrated to Secret first",
          );
        if (mcpIds.length)
          await collect(
            client,
            "bot_mcp_servers",
            `"spaceId"=$1 AND "serverId"=ANY($2::text[]) AND "botId"=ANY($3::text[])`,
            [options.scope.spaceId, mcpIds, options.scope.botIds],
          );
        await collect(client, "mcp_server_spaces", `"serverId"=ANY($1::text[]) AND "spaceId"=$2`, [
          mcpIds,
          options.scope.spaceId,
        ]);
        const skillRows = await collect(
          client,
          "agent_skills",
          `"spaceId"=$1 AND "userId"=$2 AND id=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, options.scope.agentSkillIds],
        );
        if (skillRows.length !== options.scope.agentSkillIds.length)
          throw new Error("A selected agent skill is missing or belongs to another account");
        const skillIds = fieldIds(skillRows, "id");
        if (skillIds.length)
          await collect(
            client,
            "agent_skill_spaces",
            `"skillId"=ANY($1::text[]) AND "spaceId"=$2`,
            [skillIds, options.scope.spaceId],
          );
        await collect(client, "bot_secrets", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "bot_email_addresses", `"botId"=ANY($1::text[])`, [
          options.scope.botIds,
        ]);
        await collect(client, "bot_email_messages", `"spaceId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.botIds,
        ]);
        await collect(client, "bot_email_sends", `"userId"=$1 AND "botId"=ANY($2::text[])`, [
          options.scope.userId,
          options.scope.botIds,
        ]);
        await collect(client, "notification_preferences", `"spaceId"=$1 AND "userId"=$2`, [
          options.scope.spaceId,
          options.scope.userId,
        ]);
        const memoryDocs = await collect(
          client,
          "memory_documents",
          `"spaceId"=$1 AND "userId"=$2 AND ("botId"=ANY($3::text[]) OR id=ANY($4::text[]))`,
          [
            options.scope.spaceId,
            options.scope.userId,
            options.scope.botIds,
            options.scope.sharedMemoryDocumentIds,
          ],
        );
        const selectedSharedMemoryDocs = memoryDocs.filter(
          (row) =>
            options.scope.sharedMemoryDocumentIds.includes(String(row.id)) && row.botId === null,
        );
        if (selectedSharedMemoryDocs.length !== options.scope.sharedMemoryDocumentIds.length)
          throw new Error("A selected shared memory document is missing or bot-scoped");
        const docIds = fieldIds(memoryDocs, "id");
        if (docIds.length)
          await collect(client, "memory_revisions", `"documentId"=ANY($1::text[])`, [docIds]);
        const agentSecrets = await collect(
          client,
          "agent_secrets",
          `"spaceId"=$1 AND "createdByUserId"=$2 AND id=ANY($3::text[])`,
          [options.scope.spaceId, options.scope.userId, options.scope.agentSecretIds],
        );
        if (agentSecrets.length !== options.scope.agentSecretIds.length)
          throw new Error("A selected agent secret is missing or belongs to another account");
        await collect(client, "action_approval_rules", `"spaceId"=$1 AND "createdByUserId"=$2`, [
          options.scope.spaceId,
          options.scope.userId,
        ]);
        await collect(client, "action_auto_review_preferences", `"spaceId"=$1 AND "userId"=$2`, [
          options.scope.spaceId,
          options.scope.userId,
        ]);
        const boards = await collect(client, "boards", `"spaceId"=$1 AND id=ANY($2::text[])`, [
          options.scope.spaceId,
          options.scope.boardIds,
        ]);
        if (boards.length !== options.scope.boardIds.length)
          throw new Error("A selected board is missing or belongs to another Space");
        const boardIds = fieldIds(boards, "id");
        if (boardIds.length) {
          await collect(client, "tickets", `"spaceId"=$1 AND "boardId"=ANY($2::text[])`, [
            options.scope.spaceId,
            boardIds,
          ]);
          const ticketIds = fieldIds(collected.get("tickets")?.rows ?? [], "id");
          if (ticketIds.length)
            await collect(client, "ticket_comments", `"ticketId"=ANY($1::text[])`, [ticketIds]);
        }

        const credentials = await collect(
          client,
          "user_model_credentials",
          `"userId"=$1 AND "id"=ANY($2::text[])`,
          [options.scope.userId, options.scope.credentialIds],
        );
        const excludedCredentials = options.scope.excludedCredentialIds;
        const credentialIds = fieldIds(credentials, "id");
        if (credentialIds.length !== options.scope.credentialIds.length)
          throw new Error("A selected credential is missing or belongs to another account");
        if (credentialIds.some((id) => excludedCredentials.includes(id)))
          throw new Error("A credential cannot be both selected and excluded");
        if (excludedCredentials.length) {
          const dropped = await client.query<{ id: string }>(
            `SELECT id FROM user_model_credentials WHERE "userId"=$1 AND id=ANY($2::text[])`,
            [options.scope.userId, excludedCredentials],
          );
          if (dropped.rows.length !== excludedCredentials.length)
            throw new Error("An excluded credential ID was not found under the selected account");
        }
        if (credentialIds.length) {
          await collect(
            client,
            "space_model_preferences",
            `"spaceId"=$1 AND "userId"=$2 AND "credentialId"=ANY($3::text[])`,
            [options.scope.spaceId, options.scope.userId, credentialIds],
          );
          await collect(
            client,
            "space_model_role_choices",
            `"spaceId"=$1 AND "userId"=$2 AND ("credentialId"=ANY($3::text[]) OR "credentialId" IS NULL)`,
            [options.scope.spaceId, options.scope.userId, credentialIds],
          );
          await collect(
            client,
            "user_model_preferences",
            `"userId"=$1 AND "credentialId"=ANY($2::text[])`,
            [options.scope.userId, credentialIds],
          );
          await collect(
            client,
            "user_model_role_choices",
            `"userId"=$1 AND ("credentialId"=ANY($2::text[]) OR "credentialId" IS NULL)`,
            [options.scope.userId, credentialIds],
          );
        }
        await collect(client, "space_setting_overrides", `"spaceId"=$1 AND "userId"=$2`, [
          options.scope.spaceId,
          options.scope.userId,
        ]);

        const secretIds = referencedSecretIds(collected);
        if (secretIds.length) {
          const secrets = await collect(client, "secrets", `id=ANY($1::text[])`, [secretIds]);
          if (secrets.length !== secretIds.length)
            throw new Error("A selected credential references a missing Secret");
        }
        const fkEdges = await foreignKeyColumns(client);
        const policyTables = new Set([...Object.keys(TABLE_COLUMNS), ...INTENTIONAL_OMISSIONS]);
        const scopedTables = await client.query<{ table_name: string }>(
          `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema,table_name) WHERE c.table_schema='public' AND c.column_name='spaceId' AND t.table_type='BASE TABLE'`,
        );
        const unsupportedScopedTables: string[] = [];
        for (const { table_name } of scopedTables.rows) {
          if (policyTables.has(table_name)) continue;
          const shape = await schemaMetadata(client, table_name);
          const hasBotId = shape.allColumns.some((column) => column.name === "botId");
          const rows = hasBotId
            ? await client.query(
                `SELECT 1 FROM "${table_name}" WHERE "spaceId"=$1 AND "botId"=ANY($2::text[]) LIMIT 1`,
                [options.scope.spaceId, options.scope.botIds],
              )
            : await client.query(`SELECT 1 FROM "${table_name}" WHERE "spaceId"=$1 LIMIT 1`, [
                options.scope.spaceId,
              ]);
          if (rows.rowCount) unsupportedScopedTables.push(table_name);
        }
        if (unsupportedScopedTables.length)
          throw new Error(
            `Selected data exists in unsupported Space tables: ${unsupportedScopedTables.sort().join(", ")}`,
          );
        await assertNoUnselectedInboundRows(client, collected, options.scope.botIds);
        const schemaForHash: Record<string, unknown> = {};
        for (const table of collected.keys()) {
          const { allColumns } = await schemaMetadata(client, table);
          schemaForHash[table] = allColumns;
        }
        const sourceSchemaFingerprint = fingerprint(schemaForHash);

        if (!options.dryRun && !options.rehearsalExport) {
          const unstoppedComputers = (collected.get("computers")?.rows ?? []).some(
            (row) => row.state !== "stopped",
          );
          const openComputerRuns = (collected.get("computer_runs")?.rows ?? []).some(
            (row) => row.endedAt === null || row.endedAt === undefined,
          );
          if (unstoppedComputers || openComputerRuns)
            throw new Error(
              "Selected computers must be stopped and open computer-run history closed before export",
            );
        }

        if (options.dryRun) {
          if (options.externalRefsOutput) {
            const artifacts = (collected.get("artifacts")?.rows ?? [])
              .map((row) => ({
                id: row.id,
                botId: row.botId,
                storageKey: row.storageKey,
                size: row.size,
                hash: row.hash,
                mimeType: row.mimeType,
              }))
              .sort((left, right) => String(left.id).localeCompare(String(right.id)));
            const computerHomes = (collected.get("computers")?.rows ?? [])
              .filter((row) => row.homeStorageKey !== null && row.homeStorageKey !== undefined)
              .map((row) => ({
                computerId: row.id,
                homeStorageId: row.homeStorageId,
                storageKey: row.homeStorageKey,
                revision: row.homeStorageRevision,
              }))
              .sort((left, right) =>
                String(left.computerId).localeCompare(String(right.computerId)),
              );
            await writePrivate(
              options.externalRefsOutput,
              `${JSON.stringify({ version: 1, artifacts, computerHomes }, null, 2)}\n`,
            );
          }
          await client.query("ROLLBACK");
          const rowCount = [...collected.values()].reduce(
            (total, table) => total + table.rows.length,
            0,
          );
          process.stdout.write(
            `Dry run passed: ${options.scope.botIds.length} selected bots; ${collected.size} tables; ${rowCount} rows; ${fkEdges.length} foreign-key constraints checked.${options.externalRefsOutput ? " External file references written privately." : ""}\nSource schema fingerprint: ${sourceSchemaFingerprint}\nIntentional table omissions: ${[
              ...INTENTIONAL_OMISSIONS,
            ]
              .filter((table) => table !== "space_keys")
              .sort()
              .join(", ")}\n`,
          );
          return;
        }
        if (
          !options.expectedSchemaFingerprint ||
          options.expectedSchemaFingerprint !== sourceSchemaFingerprint
        )
          throw new Error(
            "Source schema fingerprint changed or was not pinned from a successful dry run",
          );
        const bundleId = randomUUID();
        const encryptedValues: AccountTransferBundle["encryptedValues"] = [];
        const sourceSecrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
        const secretRows = secretIds.length
          ? await client.query<{
              id: string;
              userId: string;
              spaceId: string | null;
              ciphertext: string;
            }>(`SELECT id,"userId","spaceId",ciphertext FROM secrets WHERE id=ANY($1::text[])`, [
              secretIds,
            ])
          : {
              rows: [] as {
                id: string;
                userId: string;
                spaceId: string | null;
                ciphertext: string;
              }[],
            };
        if (secretRows.rows.length !== secretIds.length)
          throw new Error("A selected credential references a missing Secret");
        for (const secret of secretRows.rows) {
          if (
            secret.userId !== options.scope.userId ||
            (secret.spaceId !== null && secret.spaceId !== options.scope.spaceId)
          )
            throw new Error(
              "A selected credential references a Secret owned by another account or Space",
            );
          if (secret.ciphertext.startsWith("infisical:"))
            throw new Error("Remote secret references require a separate provider migration");
          const plaintext = await sourceSecrets.load(secret.ciphertext, secret.id);
          encryptedValues.push({
            table: "secrets",
            id: secret.id,
            column: "ciphertext",
            envelope: sealForRecipient(publicKey, Buffer.from(plaintext), `secret:${secret.id}`),
          });
        }
        const botSecrets = collected.get("bot_secrets")?.rows ?? [];
        if (botSecrets.length) {
          const directSecrets = await client.query<{
            id: string;
            userId: string;
            spaceId: string;
            ciphertext: string;
          }>(`SELECT id,"userId","spaceId",ciphertext FROM bot_secrets WHERE id=ANY($1::text[])`, [
            fieldIds(botSecrets, "id"),
          ]);
          if (directSecrets.rows.length !== botSecrets.length)
            throw new Error("A selected bot secret row is incomplete");
          for (const secret of directSecrets.rows) {
            if (secret.userId !== options.scope.userId || secret.spaceId !== options.scope.spaceId)
              throw new Error("A selected bot secret belongs to another account or Space");
            if (secret.ciphertext.startsWith("infisical:"))
              throw new Error("Remote secret references require a separate provider migration");
            const plaintext = await sourceSecrets.load(secret.ciphertext, secret.id);
            encryptedValues.push({
              table: "bot_secrets",
              id: secret.id,
              column: "ciphertext",
              envelope: sealForRecipient(
                publicKey,
                Buffer.from(plaintext),
                `bot_secrets:${secret.id}`,
              ),
            });
          }
        }
        const keyRecords = await contentKeys.all(options.scope.spaceId);
        if (!keyRecords.length && collected.size > 0)
          throw new Error(
            "Selected Space has no content keys; verify encryption mode before transfer",
          );
        const spaceKeys = keyRecords.map((key) => ({
          id: key.id,
          spaceId: key.spaceId,
          version: key.version,
          envelope: sealForRecipient(
            publicKey,
            Buffer.from(key.key),
            `space-key:${key.id}:${key.spaceId}:${key.version}`,
          ),
        }));
        await sourceSecrets.close();

        const tables: Record<string, BundleTable> = {};
        for (const [table, result] of collected) {
          const columns = result.columns;
          if (result.primaryKey.some((pk) => !columns.some((column) => column.name === pk)))
            throw new Error(`Transfer policy omits part of ${table}'s primary key`);
          const rows = result.rows.map((row) =>
            columns.map((column) => serializePg(row[column.name])),
          );
          tables[table] = { columns, primaryKey: result.primaryKey, rows };
        }
        for (const row of tables.routines?.rows ?? []) {
          const active = tables.routines!.columns.findIndex((column) => column.name === "active");
          const nextRun = tables.routines!.columns.findIndex(
            (column) => column.name === "nextRunAt",
          );
          if (active >= 0) row[active] = false;
          if (nextRun >= 0) row[nextRun] = null;
        }
        for (const table of ["runs", "tasks"] as const) {
          const data = tables[table];
          if (!data) continue;
          const statusIndex = data.columns.findIndex((column) => column.name === "status");
          const terminal = new Set([
            "completed",
            "complete",
            "succeeded",
            "failed",
            "cancelled",
            "canceled",
            "expired",
          ]);
          if (
            !options.rehearsalExport &&
            data.rows.some((row) => !terminal.has(String(row[statusIndex])))
          )
            throw new Error(`Selected ${table} include active work; pause/drain source and retry`);
        }
        for (const row of tables.computers?.rows ?? []) {
          for (const key of [
            "providerRef",
            "controlLeaseId",
            "controlLeaseExpiresAt",
            "controlBotId",
            "controlUserId",
            "executionRunId",
            "executionBotId",
            "executionLeaseExpiresAt",
            "maintenanceId",
            "screenUrl",
            "runningSince",
            "autoRecoveredAt",
          ] as const) {
            const index = tables.computers!.columns.findIndex((column) => column.name === key);
            if (index >= 0) row[index] = null;
          }
          const stateIndex = tables.computers!.columns.findIndex(
            (column) => column.name === "state",
          );
          if (stateIndex >= 0) row[stateIndex] = "stopped";
        }
        for (const entry of encryptedValues) {
          const table = tables[entry.table];
          if (!table) continue;
          const idIndex = table.columns.findIndex((column) => column.name === "id");
          const cipherIndex = table.columns.findIndex((column) => column.name === "ciphertext");
          if (cipherIndex >= 0) {
            const row = table.rows.find((candidate) => candidate[idIndex] === entry.id);
            if (row) row[cipherIndex] = "__recipient_envelope__";
          }
        }
        const unsigned = {
          version: BUNDLE_VERSION as typeof BUNDLE_VERSION,
          purpose: options.rehearsalExport ? ("rehearsal" as const) : ("cutover" as const),
          bundleId,
          scope: options.scope,
          schemaFingerprint: sourceSchemaFingerprint,
          tables,
          spaceKeys,
          encryptedValues,
          omissions: {
            reconnectCredentialIds: options.scope.excludedCredentialIds,
            inactiveRoutineIds: fieldIds(collected.get("routines")?.rows ?? [], "id"),
            omittedTables: [...INTENTIONAL_OMISSIONS]
              .filter((table) => table !== "space_keys")
              .sort(),
          },
        };
        targetBundle = { ...unsigned, manifestHash: bundleManifestHash(unsigned) };
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    if (targetBundle) {
      const body = `${JSON.stringify(targetBundle)}\n`;
      await writePrivate(options.output, body);
      process.stdout.write(
        `Encrypted transfer bundle written. ${Object.entries(targetBundle.tables)
          .map(([name, table]) => `${name}:${table.rows.length}`)
          .join(" ")}\n`,
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await pool.end();
  }
}
