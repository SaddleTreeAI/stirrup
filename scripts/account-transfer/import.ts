import {
  contentKeyProviderFromEnv,
  EncryptedSecretStore,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core/secrets-guard";
import { createDb, runAsSystem } from "@rakazo/db";
import type { AccountTransferBundle, BundleTable } from "./bundle.js";
import { assertBundleImportMode, assertTargetColumnsCompatible, validateBundle } from "./bundle.js";
import { fromJsonValue, openRecipientEnvelope } from "./crypto.js";
import { readBounded } from "./io.js";
import { TABLE_COLUMNS } from "./policy.js";
import type { ForeignKeyColumn } from "./schema.js";
import { assertCapturedForeignKeys, foreignKeyColumns, schemaMetadata } from "./schema.js";
import { conflictBatches, primaryKeyConflictQuery, quotedIdentifier } from "./sql.js";

function groupForeignKeys(edges: ForeignKeyColumn[]) {
  const groups = new Map<string, ForeignKeyColumn[]>();
  for (const edge of edges) {
    const key = `${edge.table}.${edge.constraint}`;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  return [...groups.values()];
}

function importTablePlan(
  bundle: AccountTransferBundle,
  edges: ForeignKeyColumn[],
  schemas: Map<string, Awaited<ReturnType<typeof schemaMetadata>>>,
) {
  const tables = Object.keys(bundle.tables);
  const included = new Set(tables);
  const dependencies = new Map(tables.map((table) => [table, new Set<string>()]));
  const optional: ForeignKeyColumn[][] = [];
  const deferred: ForeignKeyColumn[][] = [];
  const groups = groupForeignKeys(edges).filter((parts) => {
    const edge = parts[0]!;
    const child = bundle.tables[edge.table];
    if (!child || !included.has(edge.referencedTable)) return false;
    const indexes = parts.map((part) =>
      child.columns.findIndex((column) => column.name === part.column),
    );
    if (indexes.some((index) => index < 0)) return false;
    return child.rows.some((row) =>
      indexes.every((index) => row[index] !== null && row[index] !== undefined),
    );
  });
  for (const parts of groups) {
    const edge = parts[0]!;
    const canDefer = parts.every(
      (part) =>
        schemas.get(edge.table)?.allColumns.find((column) => column.name === part.column)?.nullable,
    );
    const threadOwnerEdge =
      edge.table === "threads" &&
      parts.some((part) => part.column === "botId" || part.column === "groupId");
    if (canDefer && !threadOwnerEdge) optional.push(parts);
    else if (edge.table === edge.referencedTable) {
      if (!canDefer) throw new Error("Non-null self-referencing foreign key prevents safe import");
      deferred.push(parts);
    } else dependencies.get(edge.table)!.add(edge.referencedTable);
  }

  const reaches = (start: string, target: string, graph: Map<string, Set<string>>) => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(graph.get(current) ?? []));
    }
    return false;
  };

  // Keep nullable references in the insert dependency graph whenever their parent can be
  // inserted first. Defer only self-references and the optional edges that would close a cycle.
  for (const parts of optional) {
    const edge = parts[0]!;
    if (
      edge.table === edge.referencedTable ||
      reaches(edge.referencedTable, edge.table, dependencies)
    ) {
      deferred.push(parts);
    } else {
      dependencies.get(edge.table)!.add(edge.referencedTable);
    }
  }

  const output: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (table: string) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) throw new Error("Non-null foreign-key cycle prevents safe import");
    visiting.add(table);
    for (const parent of dependencies.get(table) ?? []) visit(parent);
    visiting.delete(table);
    visited.add(table);
    output.push(table);
  };
  for (const table of tables) visit(table);
  return { tables: output, deferred };
}

function bundleRowObject(table: BundleTable, row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(
    table.columns.map((column, index) => [column.name, fromJsonValue(row[index])]),
  );
}

export async function importBundle(options: {
  input: string;
  privateKeyFile: string;
  dryRun: boolean;
}) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const rawBundle = await readBounded(options.input, 2_000_000_000);
  const bundle = validateBundle(JSON.parse(rawBundle.toString("utf8")));
  assertBundleImportMode(bundle, options.dryRun);
  await unwrapEnvFromKeyManager();
  const privateKey = await readBounded(options.privateKeyFile, 32_768);
  for (const table of Object.keys(bundle.tables)) {
    if (!(table in TABLE_COLUMNS)) throw new Error(`Bundle contains unsupported table ${table}`);
  }
  const bundleSecretMap = new Map<string, AccountTransferBundle["encryptedValues"][number]>();
  for (const value of bundle.encryptedValues) {
    const key = `${value.table}:${value.id}`;
    if (bundleSecretMap.has(key)) throw new Error("Bundle repeats an encrypted secret record");
    if (
      !bundle.tables[value.table]?.rows.some((row) => {
        const table = bundle.tables[value.table]!;
        const idIndex = table.columns.findIndex((column) => column.name === "id");
        const cipherIndex = table.columns.findIndex((column) => column.name === "ciphertext");
        return (
          idIndex >= 0 &&
          cipherIndex >= 0 &&
          row[idIndex] === value.id &&
          row[cipherIndex] === "__recipient_envelope__"
        );
      })
    )
      throw new Error("Bundle secret envelope has no matching encrypted record");
    bundleSecretMap.set(key, value);
  }
  const { prisma, pool, contentKeys } = createDb(process.env.DATABASE_URL, {
    applicationName: "account-transfer-target-import",
    keyProvider: contentKeyProviderFromEnv(),
    encryptContent: false,
  });
  const targetSecrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const stagedRows = new Map<string, Record<string, unknown>[]>();
  try {
    await runAsSystem("selectively import one transferred account", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const schemas = new Map<string, Awaited<ReturnType<typeof schemaMetadata>>>();
        for (const [table, exported] of Object.entries(bundle.tables)) {
          const target = await schemaMetadata(client, table);
          assertTargetColumnsCompatible(exported.columns, target.allColumns, table);
          if (JSON.stringify(exported.primaryKey) !== JSON.stringify(target.primaryKey))
            throw new Error(`Incompatible primary key for ${table}`);
          schemas.set(table, target);
          const keyIndices = exported.primaryKey.map((column) =>
            exported.columns.findIndex((entry) => entry.name === column),
          );
          const targetRows = exported.rows.map((row) =>
            Object.fromEntries(
              exported.primaryKey.map((column, index) => [
                column,
                fromJsonValue(row[keyIndices[index]!]),
              ]),
            ),
          );
          for (const rows of conflictBatches(targetRows, exported.primaryKey)) {
            const query = primaryKeyConflictQuery(
              table,
              exported.primaryKey,
              rows,
              target.allColumns,
            );
            const relation = await client.query(query.sql, query.values);
            if (relation.rowCount)
              throw new Error(
                `Target contains conflicting ${table} identifiers; import is atomic and will not overwrite them`,
              );
          }
        }
        const edges = await foreignKeyColumns(client);
        const bundleRows = new Map(
          Object.entries(bundle.tables).map(([tableName, table]) => [
            tableName,
            {
              columns: table.columns,
              primaryKey: table.primaryKey,
              rows: table.rows.map((row) => bundleRowObject(table, row)),
            },
          ]),
        );
        assertCapturedForeignKeys(edges, bundleRows);
        const insertPlan = importTablePlan(bundle, edges, schemas);
        for (const key of bundle.spaceKeys) {
          const conflict = await client.query(
            `SELECT 1 FROM space_keys WHERE id=$1 OR ("spaceId"=$2 AND version=$3) LIMIT 1`,
            [key.id, key.spaceId, key.version],
          );
          if (conflict.rowCount)
            throw new Error(
              "Target contains a conflicting Space key; import will not overwrite it",
            );
        }
        for (const [tableName, table] of Object.entries(bundle.tables)) {
          const records: Record<string, unknown>[] = [];
          for (const tuple of table.rows) {
            const row = bundleRowObject(table, tuple);
            for (const column of table.columns) {
              if (row[column.name] !== "__recipient_envelope__") continue;
              const envelope = bundleSecretMap.get(`${tableName}:${String(row.id)}`);
              if (!envelope) throw new Error("Bundle omitted a selected secret envelope");
              const context =
                envelope.table === "secrets"
                  ? `secret:${envelope.id}`
                  : `${envelope.table}:${envelope.id}`;
              const plaintext = openRecipientEnvelope(
                privateKey,
                envelope.envelope,
                context,
              ).toString("utf8");
              const stored = await targetSecrets.put(
                plaintext,
                {
                  operationId: bundle.bundleId,
                  traceId: bundle.bundleId,
                  spaceId: bundle.scope.spaceId,
                  userId: bundle.scope.userId,
                  signal: new AbortController().signal,
                },
                { recordId: String(row.id) },
              );
              row[column.name] = stored.ciphertext;
            }
            records.push(row);
          }
          stagedRows.set(tableName, records);
        }
        for (const tableName of insertPlan.tables) {
          const table = bundle.tables[tableName]!;
          const records = stagedRows.get(tableName)!;
          const deferredColumns = new Set(
            insertPlan.deferred
              .filter((parts) => parts[0]!.table === tableName)
              .flatMap((parts) => parts.map((part) => part.column)),
          );
          for (let rowIndex = 0; rowIndex < records.length; rowIndex++) {
            const record = records[rowIndex]!;
            for (const column of deferredColumns) {
              if (record[column] !== null && record[column] !== undefined) {
                const original = record[column];
                record[`__deferred:${column}`] = original;
                record[column] = null;
              }
            }
            const columns = table.columns.filter(
              (column) => !column.name.startsWith("__deferred:"),
            );
            const values = columns.map((column) => {
              const value = record[column.name];
              const targetColumn = schemas
                .get(tableName)
                ?.allColumns.find((candidate) => candidate.name === column.name);
              return targetColumn?.udtName === "json" || targetColumn?.udtName === "jsonb"
                ? value === null || value === undefined
                  ? value
                  : JSON.stringify(value)
                : value;
            });
            await client.query(
              `INSERT INTO ${quotedIdentifier(tableName)} (${columns.map((column) => quotedIdentifier(column.name)).join(",")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})`,
              values,
            );
          }
        }
        const deferredColumnsByTable = new Map<string, Set<string>>();
        for (const parts of insertPlan.deferred) {
          const edge = parts[0]!;
          deferredColumnsByTable.set(
            edge.table,
            new Set([
              ...(deferredColumnsByTable.get(edge.table) ?? []),
              ...parts.map((part) => part.column),
            ]),
          );
        }
        for (const [tableName, table] of Object.entries(bundle.tables)) {
          const deferredColumns = deferredColumnsByTable.get(tableName);
          if (!deferredColumns?.size) continue;
          const pkColumns = table.primaryKey;
          for (const record of stagedRows.get(tableName) ?? []) {
            for (const column of deferredColumns) {
              const value = record[`__deferred:${column}`];
              if (value === undefined) continue;
              const whereValues = pkColumns.map((key) => record[key]);
              await client.query(
                `UPDATE ${quotedIdentifier(tableName)} SET ${quotedIdentifier(column)}=$1 WHERE ${pkColumns.map((key, index) => `${quotedIdentifier(key)}=$${index + 2}`).join(" AND ")}`,
                [value, ...whereValues],
              );
            }
          }
        }
        for (const key of bundle.spaceKeys) {
          const dataKey = openRecipientEnvelope(
            privateKey,
            key.envelope,
            `space-key:${key.id}:${key.spaceId}:${key.version}`,
          );
          const wrapped = await contentKeys.provider.wrap(dataKey, {
            spaceId: key.spaceId,
            version: key.version,
          });
          await client.query(
            `INSERT INTO space_keys (id,"spaceId",version,"masterKeyId","wrappedKey") VALUES ($1,$2,$3,$4,$5)`,
            [key.id, key.spaceId, key.version, wrapped.masterKeyId, wrapped.wrappedKey],
          );
        }
        if (options.dryRun) {
          await client.query("ROLLBACK");
          const rowCount = Object.values(bundle.tables).reduce(
            (total, table) => total + table.rows.length,
            0,
          );
          process.stdout.write(
            `Target dry run passed: ${Object.keys(bundle.tables).length} tables; ${rowCount} rows; target schema is compatible. No rows committed.\n`,
          );
          return;
        }
        await client.query("COMMIT");
        const rowCount = Object.values(bundle.tables).reduce(
          (total, table) => total + table.rows.length,
          0,
        );
        process.stdout.write(
          `Imported ${rowCount} rows across ${Object.keys(bundle.tables).length} tables.\n`,
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  } finally {
    await targetSecrets.close();
    await prisma.$disconnect().catch(() => undefined);
    await pool.end();
  }
}
