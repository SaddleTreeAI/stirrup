import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountTransferBundle, ColumnShape } from "./bundle.js";
import { bundleManifestHash } from "./bundle.js";
import { sealForRecipient } from "./crypto.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  wrap: vi.fn(),
  put: vi.fn(),
  close: vi.fn(),
  disconnect: vi.fn(),
  stdout: vi.fn(),
}));

vi.mock("@rakazo/adapters", () => ({
  contentKeyProviderFromEnv: () => undefined,
  unwrapEnvFromKeyManager: async () => undefined,
  EncryptedSecretStore: class {
    put = mocks.put;
    close = mocks.close;
  },
}));
vi.mock("@rakazo/core/secrets-guard", () => ({
  resolveEncryptionKey: () => "test-encryption-key",
}));
vi.mock("@rakazo/db", () => ({
  createDb: () => ({
    prisma: { $disconnect: mocks.disconnect },
    pool: { connect: mocks.connect, end: vi.fn() },
    contentKeys: { provider: { wrap: mocks.wrap } },
  }),
  runAsSystem: async (_reason: string, fn: () => Promise<void>) => fn(),
}));

import { importBundle } from "./import.js";

let workingDir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (workingDir) await rm(workingDir, { recursive: true, force: true });
  workingDir = undefined;
});

const column = (name: string): ColumnShape => ({
  name,
  dataType: "text",
  udtName: "text",
  nullable: false,
  hasDefault: false,
});

describe("account-transfer import transaction", () => {
  it("preserves owner membership and leaves platform role to target bootstrap", async () => {
    workingDir = await mkdtemp(path.join(os.tmpdir(), "account-transfer-import-"));
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateFile = path.join(workingDir, "recipient-private.pem");
    const inputFile = path.join(workingDir, "bundle.json");
    await writeFile(privateFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    const dataKey = Buffer.from("space-data-key-fixture");
    const tables = {
      user: {
        columns: [column("id"), column("email")],
        primaryKey: ["id"],
        rows: [["user-a", "owner@example.test"]],
      },
      organization: {
        columns: [column("id"), column("slug")],
        primaryKey: ["id"],
        rows: [["org-a", "owner-org"]],
      },
      member: {
        columns: [column("id"), column("organizationId"), column("userId"), column("role")],
        primaryKey: ["id"],
        rows: [["member-a", "org-a", "user-a", "owner"]],
      },
      spaces: {
        columns: [column("id"), column("organizationId"), column("name")],
        primaryKey: ["id"],
        rows: [["space-a", "org-a", "Owner Space"]],
      },
      space_members: {
        columns: [
          column("id"),
          column("spaceId"),
          column("organizationId"),
          column("userId"),
          column("role"),
        ],
        primaryKey: ["id"],
        rows: [["space-member-a", "space-a", "org-a", "user-a", "owner"]],
      },
    };
    const base = {
      version: 2 as const,
      purpose: "cutover" as const,
      bundleId: "bundle-a",
      scope: {
        userId: "user-a",
        organizationId: "org-a",
        spaceId: "space-a",
        botIds: ["bot-a"],
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
      schemaFingerprint: "fixture-schema",
      tables,
      spaceKeys: [
        {
          id: "key-a",
          spaceId: "space-a",
          version: 1,
          envelope: sealForRecipient(pair.publicKey, dataKey, "space-key:key-a:space-a:1"),
        },
      ],
      encryptedValues: [],
      omissions: { reconnectCredentialIds: [], inactiveRoutineIds: [], omittedTables: [] },
    };
    const bundle: AccountTransferBundle = { ...base, manifestHash: bundleManifestHash(base) };
    await writeFile(inputFile, JSON.stringify(bundle));

    const inserted: Array<{ sql: string; values: unknown[] }> = [];
    const targetColumns = new Map(
      Object.entries(tables).map(([table, shape]) => [table, shape.columns]),
    );
    const targetPks = new Map(
      Object.entries(tables).map(([table, shape]) => [table, shape.primaryKey]),
    );
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("information_schema.columns")) {
          const names = targetColumns.get(String(values[0])) ?? [];
          return {
            rows: names.map((entry) => ({
              column_name: entry.name,
              data_type: entry.dataType,
              udt_name: entry.udtName,
              is_nullable: "NO",
              column_default: null,
            })),
            rowCount: names.length,
          };
        }
        if (sql.includes("information_schema.table_constraints")) {
          const names = targetPks.get(String(values[0])) ?? [];
          return {
            rows: names.map((name, index) => ({ column_name: name, ordinal_position: index + 1 })),
            rowCount: names.length,
          };
        }
        if (sql.includes("FROM pg_constraint")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("INSERT INTO") || sql.startsWith("UPDATE "))
          inserted.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);
    mocks.wrap.mockResolvedValue({
      masterKeyId: "target-master",
      wrappedKey: "target-wrapped-key",
    });
    mocks.put.mockResolvedValue({ ciphertext: "target-ciphertext" });
    mocks.close.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    vi.stubEnv("DATABASE_URL", "postgres://target-fixture");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);

    const rehearsal = { ...base, purpose: "rehearsal" as const };
    const rehearsalFile = path.join(workingDir, "rehearsal.json");
    await writeFile(
      rehearsalFile,
      JSON.stringify({ ...rehearsal, manifestHash: bundleManifestHash(rehearsal) }),
    );
    await expect(
      importBundle({ input: rehearsalFile, privateKeyFile: privateFile, dryRun: false }),
    ).rejects.toThrow(/only.*--dry-run/);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.wrap).not.toHaveBeenCalled();

    await importBundle({ input: inputFile, privateKeyFile: privateFile, dryRun: false });

    const memberInsert = inserted.find((entry) => entry.sql.startsWith('INSERT INTO "member"'));
    const spaceMemberInsert = inserted.find((entry) =>
      entry.sql.startsWith('INSERT INTO "space_members"'),
    );
    const userInsert = inserted.find((entry) => entry.sql.startsWith('INSERT INTO "user"'));
    expect(memberInsert?.values).toEqual(["member-a", "org-a", "user-a", "owner"]);
    expect(spaceMemberInsert?.values).toEqual([
      "space-member-a",
      "space-a",
      "org-a",
      "user-a",
      "owner",
    ]);
    expect(userInsert?.sql).not.toContain("platformRole");
    expect(inserted.some((entry) => entry.sql.startsWith("INSERT INTO space_keys"))).toBe(true);
    expect(mocks.wrap).toHaveBeenCalledWith(dataKey, { spaceId: "space-a", version: 1 });
    expect(stdout).toHaveBeenCalled();
  });
});
