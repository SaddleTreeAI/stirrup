import { describe, expect, it } from "vitest";
import type { AccountTransferBundle, ColumnShape } from "./bundle.js";
import {
  assertBundleImportMode,
  assertTargetColumnsCompatible,
  bundleManifestHash,
  validateBundle,
} from "./bundle.js";

const col = (name: string, nullable = false, hasDefault = false): ColumnShape => ({
  name,
  dataType: "text",
  udtName: "text",
  nullable,
  hasDefault,
});

function fixture(): AccountTransferBundle {
  const base = {
    version: 2 as const,
    purpose: "cutover" as const,
    bundleId: "fixture-bundle",
    scope: {
      userId: "user-fixture",
      organizationId: "org-fixture",
      spaceId: "space-fixture",
      botIds: ["bot-fixture"],
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
    schemaFingerprint: "schema-hash",
    tables: {
      bots: { columns: [col("id")], primaryKey: ["id"], rows: [["bot-fixture"]] },
    },
    spaceKeys: [],
    encryptedValues: [],
    omissions: { reconnectCredentialIds: [], inactiveRoutineIds: [], omittedTables: [] },
  };
  return { ...base, manifestHash: bundleManifestHash(base) };
}

describe("account-transfer bundle validation", () => {
  it("rejects committing a rehearsal snapshot and checks its purpose integrity", () => {
    const { manifestHash: _oldHash, ...unsigned } = fixture();
    const rehearsal = { ...unsigned, purpose: "rehearsal" as const };
    const bundle = validateBundle({ ...rehearsal, manifestHash: bundleManifestHash(rehearsal) });
    expect(() => assertBundleImportMode(bundle, false)).toThrow(/only.*--dry-run/);
    expect(() => assertBundleImportMode(bundle, true)).not.toThrow();
    expect(() => validateBundle({ ...bundle, purpose: "cutover" })).toThrow(/integrity/);
  });
  it("accepts a valid schema-pinned bundle and rejects tampering", () => {
    expect(validateBundle(fixture()).bundleId).toBe("fixture-bundle");
    const tampered = fixture();
    tampered.tables.bots!.rows[0]![0] = "different-bot";
    expect(() => validateBundle(tampered)).toThrow(/integrity/i);
  });

  it("allows target schema additions with defaults while rejecting missing required columns", () => {
    assertTargetColumnsCompatible(
      [col("id")],
      [col("id"), col("newDefaulted", false, true), col("newNullable", true)],
      "bots",
    );
    expect(() =>
      assertTargetColumnsCompatible([col("id")], [col("id"), col("required")], "bots"),
    ).toThrow(/required column/);
  });

  it("rejects incompatible source and target column types", () => {
    expect(() =>
      assertTargetColumnsCompatible(
        [col("id")],
        [{ ...col("id"), dataType: "character varying", udtName: "varchar" }],
        "bots",
      ),
    ).toThrow(/Incompatible type/);
  });

  it("refuses to carry a platform role into a target account", () => {
    const bundle = fixture();
    bundle.tables.user = {
      columns: [col("id"), col("platformRole")],
      primaryKey: ["id"],
      rows: [["user-fixture", "owner"]],
    };
    const { manifestHash: _oldHash, ...unsigned } = bundle;
    const altered = { ...unsigned, manifestHash: bundleManifestHash(unsigned) };
    expect(() => validateBundle(altered)).toThrow(/Platform role must be bootstrapped/);
  });

  it("preserves sole-member organization and Space roles for account adoption", () => {
    const bundle = fixture();
    bundle.tables.user = {
      columns: [col("id"), col("email")],
      primaryKey: ["id"],
      rows: [["user-fixture", "person@example.test"]],
    };
    bundle.tables.member = {
      columns: [col("id"), col("role")],
      primaryKey: ["id"],
      rows: [["member-fixture", "owner"]],
    };
    bundle.tables.space_members = {
      columns: [col("id"), col("role")],
      primaryKey: ["id"],
      rows: [["space-member-fixture", "owner"]],
    };
    const { manifestHash: oldHash, ...unsigned } = bundle;
    void oldHash;
    const reviewed = { ...unsigned, manifestHash: bundleManifestHash(unsigned) };
    const imported = validateBundle(reviewed);
    expect(imported.tables.member?.rows[0]?.[1]).toBe("owner");
    expect(imported.tables.space_members?.rows[0]?.[1]).toBe("owner");
    expect(imported.tables.user?.columns.some((column) => column.name === "platformRole")).toBe(
      false,
    );
  });
});
