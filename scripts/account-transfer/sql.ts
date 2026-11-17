import type { ColumnShape } from "./bundle.js";

export function quotedIdentifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new Error("Unsafe database identifier");
  return `"${value}"`;
}

export function conflictBatches<T>(rows: T[], keyColumns: string[], maxParameters = 50_000): T[][] {
  if (!keyColumns.length || keyColumns.length > maxParameters)
    throw new Error("Invalid primary-key column count");
  const batchSize = Math.max(1, Math.floor(maxParameters / keyColumns.length));
  const batches: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += batchSize)
    batches.push(rows.slice(offset, offset + batchSize));
  return batches;
}

export function primaryKeyConflictQuery(
  table: string,
  keyColumns: string[],
  rows: Record<string, unknown>[],
  columns: ColumnShape[],
) {
  if (!rows.length) throw new Error("A conflict query needs at least one row");
  const tableName = quotedIdentifier(table);
  const keys = keyColumns.map(quotedIdentifier);
  const keyTypes = new Map(columns.map((column) => [column.name, column.udtName]));
  const values: unknown[] = [];
  const tuples = rows.map(
    (row) =>
      `(${keyColumns
        .map((key) => {
          values.push(row[key]);
          const type = keyTypes.get(key);
          if (!type || !/^_?[A-Za-z][A-Za-z0-9_]*$/.test(type))
            throw new Error(`Unsupported primary-key type for ${table}.${key}`);
          const castType = type.startsWith("_")
            ? `${quotedIdentifier(type.slice(1))}[]`
            : quotedIdentifier(type);
          return `$${values.length}::${castType}`;
        })
        .join(",")})`,
  );
  const sourceColumns = keys.join(",");
  const join = keys.map((key) => `target.${key}=source.${key}`).join(" AND ");
  return {
    sql: `SELECT 1 FROM ${tableName} AS target JOIN (VALUES ${tuples.join(",")}) AS source(${sourceColumns}) ON ${join} LIMIT 1`,
    values,
  };
}
