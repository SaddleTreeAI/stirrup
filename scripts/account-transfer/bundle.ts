import type { RecipientEnvelope } from "./crypto.js";
import { fingerprint } from "./crypto.js";

export const BUNDLE_VERSION = 2;

export type ExportScope = {
  userId: string;
  organizationId: string;
  spaceId: string;
  botIds: string[];
  mcpServerIds: string[];
  credentialIds: string[];
  connectionIds: string[];
  spaceMemoryConfigIds: string[];
  agentSecretIds: string[];
  agentSkillIds: string[];
  capabilityInstallIds: string[];
  boardIds: string[];
  sharedMemoryDocumentIds: string[];
  botDeletionIds: string[];
  excludedCredentialIds: string[];
};

export type ColumnShape = {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  hasDefault: boolean;
};
export type BundleTable = { columns: ColumnShape[]; primaryKey: string[]; rows: unknown[][] };

export type AccountTransferBundle = {
  version: typeof BUNDLE_VERSION;
  purpose: "cutover" | "rehearsal";
  bundleId: string;
  scope: ExportScope;
  schemaFingerprint: string;
  tables: Record<string, BundleTable>;
  spaceKeys: Array<{
    id: string;
    spaceId: string;
    version: number;
    envelope: RecipientEnvelope;
  }>;
  encryptedValues: Array<{
    table: "secrets" | "bot_secrets" | "agent_secrets";
    id: string;
    column: "ciphertext";
    envelope: RecipientEnvelope;
  }>;
  omissions: {
    reconnectCredentialIds: string[];
    inactiveRoutineIds: string[];
    omittedTables: string[];
  };
  manifestHash: string;
};

const ALLOWED_TOP_LEVEL = new Set([
  "version",
  "purpose",
  "bundleId",
  "scope",
  "schemaFingerprint",
  "tables",
  "spaceKeys",
  "encryptedValues",
  "omissions",
  "manifestHash",
]);

export function bundleManifestHash(bundle: Omit<AccountTransferBundle, "manifestHash">): string {
  return fingerprint(bundle);
}

export function assertBundleImportMode(bundle: AccountTransferBundle, dryRun: boolean) {
  if (bundle.purpose === "rehearsal" && !dryRun)
    throw new Error("A live-source rehearsal bundle can only be imported with --dry-run");
}

export function validateBundle(value: unknown): AccountTransferBundle {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Transfer bundle must be an object");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !ALLOWED_TOP_LEVEL.has(key)))
    throw new Error("Transfer bundle has unexpected top-level data");
  if (candidate.version !== BUNDLE_VERSION || typeof candidate.bundleId !== "string")
    throw new Error("Unsupported transfer bundle version");
  if (candidate.purpose !== "cutover" && candidate.purpose !== "rehearsal")
    throw new Error("Transfer bundle purpose is invalid");
  if (typeof candidate.schemaFingerprint !== "string" || typeof candidate.manifestHash !== "string")
    throw new Error("Transfer bundle is missing its schema or integrity fingerprint");
  if (!candidate.tables || typeof candidate.tables !== "object" || Array.isArray(candidate.tables))
    throw new Error("Transfer bundle has no table data");
  const omissions = candidate.omissions as AccountTransferBundle["omissions"] | undefined;
  if (
    !omissions ||
    !Array.isArray(omissions.reconnectCredentialIds) ||
    !Array.isArray(omissions.inactiveRoutineIds) ||
    !Array.isArray(omissions.omittedTables)
  )
    throw new Error("Transfer bundle omission manifest is invalid");
  const { manifestHash, ...unsigned } = candidate;
  if (bundleManifestHash(unsigned as Omit<AccountTransferBundle, "manifestHash">) !== manifestHash)
    throw new Error("Transfer bundle integrity check failed");
  const scope = candidate.scope as ExportScope;
  if (
    !scope ||
    ![scope.userId, scope.organizationId, scope.spaceId].every(
      (item) => typeof item === "string",
    ) ||
    !Array.isArray(scope.botIds) ||
    !Array.isArray(scope.mcpServerIds) ||
    !Array.isArray(scope.credentialIds) ||
    !Array.isArray(scope.connectionIds) ||
    !Array.isArray(scope.spaceMemoryConfigIds) ||
    !Array.isArray(scope.agentSecretIds) ||
    !Array.isArray(scope.agentSkillIds) ||
    !Array.isArray(scope.capabilityInstallIds) ||
    !Array.isArray(scope.boardIds) ||
    !Array.isArray(scope.sharedMemoryDocumentIds) ||
    !Array.isArray(scope.botDeletionIds) ||
    !Array.isArray(scope.excludedCredentialIds)
  )
    throw new Error("Transfer bundle scope is invalid");
  for (const [tableName, table] of Object.entries(candidate.tables)) {
    if (!/^[a-z][a-z0-9_]*$/.test(tableName)) throw new Error("Invalid table identifier in bundle");
    const shape = table as BundleTable;
    if (
      !Array.isArray(shape.columns) ||
      !Array.isArray(shape.primaryKey) ||
      !Array.isArray(shape.rows) ||
      shape.rows.some((row) => !Array.isArray(row) || row.length !== shape.columns.length)
    )
      throw new Error(`Invalid row shape for ${tableName}`);
    if (tableName === "user" && shape.columns.some((column) => column.name === "platformRole"))
      throw new Error("Platform role must be bootstrapped on the target, not transferred");
    if (
      !shape.columns.every((column) => column && typeof column.name === "string") ||
      shape.primaryKey.some((column) => !shape.columns.some((entry) => entry.name === column))
    )
      throw new Error(`Invalid column or primary-key metadata for ${tableName}`);
    const seen = new Set<string>();
    for (const row of shape.rows) {
      const key = JSON.stringify(
        shape.primaryKey.map((column) => row[shape.columns.findIndex((c) => c.name === column)]),
      );
      if (seen.has(key)) throw new Error(`Duplicate primary key in ${tableName}`);
      seen.add(key);
    }
  }
  return candidate as unknown as AccountTransferBundle;
}

/** New target columns are safe only when old rows can receive a default or NULL. */
export function assertTargetColumnsCompatible(
  exported: ColumnShape[],
  target: ColumnShape[],
  tableName: string,
): void {
  const targetByName = new Map(target.map((column) => [column.name, column]));
  for (const sourceColumn of exported) {
    const targetColumn = targetByName.get(sourceColumn.name);
    if (!targetColumn) throw new Error(`Target is missing ${tableName}.${sourceColumn.name}`);
    if (
      targetColumn.dataType !== sourceColumn.dataType ||
      targetColumn.udtName !== sourceColumn.udtName
    )
      throw new Error(`Incompatible type for ${tableName}.${sourceColumn.name}`);
  }
  const exportedNames = new Set(exported.map((column) => column.name));
  for (const targetColumn of target) {
    if (!exportedNames.has(targetColumn.name) && !targetColumn.nullable && !targetColumn.hasDefault)
      throw new Error(`New required column ${tableName}.${targetColumn.name} has no default`);
  }
}
