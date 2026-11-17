import type { ColumnShape } from "./bundle.js";
import {
  INTENTIONAL_OMISSIONS,
  SCOPE_FILTERED_OMISSIONS,
  TABLE_COLUMNS,
  tableName,
} from "./policy.js";

export type PoolClient = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(error?: Error): void;
};

export async function schemaMetadata(client: PoolClient, table: string) {
  const columnsResult = await client.query<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  if (!columnsResult.rowCount) throw new Error(`Required table missing: ${table}`);
  const pkResult = await client.query<{ column_name: string; ordinal_position: number }>(
    `SELECT kcu.column_name,kcu.ordinal_position FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu USING (constraint_catalog,constraint_schema,constraint_name,table_name) WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY' ORDER BY kcu.ordinal_position`,
    [table],
  );
  return {
    allColumns: columnsResult.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      nullable: row.is_nullable === "YES",
      hasDefault: row.column_default !== null,
    })),
    primaryKey: pkResult.rows.map((row) => row.column_name),
  };
}

export type ForeignKeyColumn = {
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  constraint: string;
  position: number;
};

export async function foreignKeyColumns(client: PoolClient): Promise<ForeignKeyColumn[]> {
  const result =
    await client.query<ForeignKeyColumn>(`SELECT child.relname AS table, child_col.attname AS column,
      parent.relname AS "referencedTable", parent_col.attname AS "referencedColumn",
      constraint_row.conname AS "constraint", child_key.position::int AS position
    FROM pg_constraint constraint_row
    JOIN pg_class child ON child.oid=constraint_row.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=constraint_row.confrelid
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY child_key(attnum, position) ON true
    JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY parent_key(attnum, position) ON parent_key.position=child_key.position
    JOIN pg_attribute child_col ON child_col.attrelid=child.oid AND child_col.attnum=child_key.attnum
    JOIN pg_attribute parent_col ON parent_col.attrelid=parent.oid AND parent_col.attnum=parent_key.attnum
    WHERE constraint_row.contype='f' AND child_ns.nspname='public'
    ORDER BY child.relname, constraint_row.conname, child_key.position`);
  return result.rows;
}

export function assertCapturedForeignKeys(
  edges: ForeignKeyColumn[],
  collected: Map<
    string,
    { columns: ColumnShape[]; primaryKey: string[]; rows: Record<string, unknown>[] }
  >,
) {
  const byConstraint = new Map<string, ForeignKeyColumn[]>();
  for (const edge of edges) {
    const key = `${edge.table}.${edge.constraint}`;
    byConstraint.set(key, [...(byConstraint.get(key) ?? []), edge]);
  }
  for (const [key, parts] of byConstraint) {
    const child = collected.get(parts[0]!.table);
    if (!child) continue;
    const parent = collected.get(parts[0]!.referencedTable);
    const childCols = new Set(child.columns.map((column) => column.name));
    if (parts.some((part) => !childCols.has(part.column)))
      throw new Error(`Transfer policy omits a foreign-key column for ${key}`);
    const references = child.rows
      .map((row) => parts.map((part) => row[part.column]))
      .filter((values) => values.every((value) => value !== null && value !== undefined));
    if (!references.length) continue;
    if (!parent)
      throw new Error(
        `Selected ${parts[0]!.table} rows depend on unsupported table ${parts[0]!.referencedTable}`,
      );
    const selectedParentRows = parent.rows;
    const parentCols = new Set(parent.columns.map((column) => column.name));
    if (parts.some((part) => !parentCols.has(part.referencedColumn)))
      throw new Error(`Transfer policy omits a referenced key for ${key}`);
    const parentKeys = new Set(
      selectedParentRows.map((row) =>
        JSON.stringify(parts.map((part) => row[part.referencedColumn])),
      ),
    );
    for (const values of references) {
      if (!parentKeys.has(JSON.stringify(values)))
        throw new Error(
          `Selected ${parts[0]!.table} row has an unresolved foreign key (${parts[0]!.constraint})`,
        );
    }
  }
}

export async function assertNoUnselectedInboundRows(
  client: PoolClient,
  collected: Map<
    string,
    { columns: ColumnShape[]; primaryKey: string[]; rows: Record<string, unknown>[] }
  >,
  botIds: string[],
) {
  const edges = await foreignKeyColumns(client);
  const byConstraint = new Map<string, ForeignKeyColumn[]>();
  for (const edge of edges) {
    const key = `${edge.table}.${edge.constraint}`;
    byConstraint.set(key, [...(byConstraint.get(key) ?? []), edge]);
  }
  const unselectedTables = new Set<string>();
  for (const parts of byConstraint.values()) {
    const edge = parts[0]!;
    const parent = collected.get(edge.referencedTable);
    if (
      !parent?.rows.length ||
      INTENTIONAL_OMISSIONS.has(edge.table) ||
      SCOPE_FILTERED_OMISSIONS.has(edge.table)
    )
      continue;
    const childShape = await schemaMetadata(client, edge.table);
    const hasBotId = childShape.allColumns.some((column) => column.name === "botId");
    const selectedChildKeys = new Set(
      (collected.get(edge.table)?.rows ?? []).map((row) =>
        JSON.stringify(childShape.primaryKey.map((key) => row[key])),
      ),
    );
    const keys = parent.rows.map((row) => parts.map((part) => row[part.referencedColumn]));
    let unselectedFound = false;
    for (let offset = 0; offset < keys.length; offset += 200) {
      const values: unknown[] = [];
      const tuples = keys
        .slice(offset, offset + 200)
        .map(
          (tuple) =>
            `(${tuple
              .map((value) => {
                values.push(value);
                return `$${values.length}`;
              })
              .join(",")})`,
        )
        .join(",");
      const match = parts
        .map((part, index) => `c."${part.column}" IS NOT DISTINCT FROM selected.k${index}`)
        .join(" AND ");
      const fields = [
        ...childShape.primaryKey,
        ...(hasBotId ? ["botId"] : []),
        ...(edge.table === "account" ? ["password"] : []),
      ];
      const related = await client.query<Record<string, unknown>>(
        `SELECT ${fields.map((field) => `c."${field}"`).join(",")} FROM "${edge.table}" c JOIN (VALUES ${tuples}) AS selected(${parts.map((_, index) => `k${index}`).join(",")}) ON ${match}`,
        values,
      );
      for (const row of related.rows) {
        if (selectedChildKeys.has(JSON.stringify(childShape.primaryKey.map((key) => row[key]))))
          continue;
        if (edge.table === "account" && row.password === null) continue;
        if (hasBotId && !botIds.includes(String(row.botId))) continue;
        unselectedFound = true;
        break;
      }
      if (unselectedFound) break;
    }
    if (unselectedFound) unselectedTables.add(edge.table);
  }
  if (unselectedTables.size)
    throw new Error(
      `Unselected rows reference included data in tables: ${[...unselectedTables].sort().join(", ")}`,
    );
  assertCapturedForeignKeys(edges, collected);
}

export async function capture(
  client: PoolClient,
  table: string,
  predicate: string,
  values: unknown[],
): Promise<{ columns: ColumnShape[]; primaryKey: string[]; rows: Record<string, unknown>[] }> {
  const approved = TABLE_COLUMNS[table];
  if (!approved) throw new Error(`No transfer policy for ${table}`);
  const shape = await schemaMetadata(client, table);
  const columns = shape.allColumns.filter((column) => approved.includes(column.name));
  const missing = approved.filter(
    (name) => !shape.allColumns.some((column) => column.name === name),
  );
  // Source releases can predate optional fields; required identity columns cannot.
  const required = approved.filter((name) =>
    ["id", "spaceId", "userId", "botId", "threadId"].includes(name),
  );
  if (required.some((name) => missing.includes(name)))
    throw new Error(`Schema is too old for ${table}`);
  const rows = await client.query<Record<string, unknown>>(
    `SELECT ${columns.map((column) => `"${column.name}"`).join(",")} FROM ${tableName(table)} WHERE ${predicate}`,
    values,
  );
  return { columns, primaryKey: shape.primaryKey, rows: rows.rows };
}
