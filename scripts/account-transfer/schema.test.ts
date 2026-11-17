import { describe, expect, it } from "vitest";
import type { ColumnShape } from "./bundle.js";
import { assertCapturedForeignKeys } from "./schema.js";

const column = (name: string): ColumnShape => ({
  name,
  dataType: "text",
  udtName: "text",
  nullable: false,
  hasDefault: false,
});

function captured(columns: string[], primaryKey: string[], rows: Record<string, unknown>[]) {
  return { columns: columns.map(column), primaryKey, rows };
}

const fk = {
  table: "bots",
  column: "spaceId",
  referencedTable: "spaces",
  referencedColumn: "id",
  constraint: "bots_spaceId_fkey",
  position: 1,
};

describe("account-transfer foreign-key closure", () => {
  it("accepts selected rows whose foreign keys resolve inside the bundle", () => {
    expect(() =>
      assertCapturedForeignKeys(
        [fk],
        new Map([
          ["spaces", captured(["id"], ["id"], [{ id: "space-a" }])],
          ["bots", captured(["id", "spaceId"], ["id"], [{ id: "bot-a", spaceId: "space-a" }])],
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects a selected row that points outside the selected graph", () => {
    expect(() =>
      assertCapturedForeignKeys(
        [fk],
        new Map([
          ["spaces", captured(["id"], ["id"], [{ id: "space-a" }])],
          ["bots", captured(["id", "spaceId"], ["id"], [{ id: "bot-a", spaceId: "space-b" }])],
        ]),
      ),
    ).toThrow(/unresolved foreign key/i);
  });

  it("accepts nullable composite foreign keys with one null component", () => {
    const composite = [
      {
        ...fk,
        column: "spaceId",
        constraint: "choice_credential_fkey",
        referencedTable: "user_model_credentials",
        referencedColumn: "spaceId",
        position: 1,
      },
      {
        ...fk,
        column: "credentialId",
        constraint: "choice_credential_fkey",
        referencedTable: "user_model_credentials",
        referencedColumn: "id",
        position: 2,
      },
    ];
    expect(() =>
      assertCapturedForeignKeys(
        composite,
        new Map([
          [
            "user_model_credentials",
            captured(["spaceId", "id"], ["id"], [{ spaceId: "space-a", id: "credential-a" }]),
          ],
          [
            "space_model_role_choices",
            captured(
              ["spaceId", "credentialId"],
              ["spaceId"],
              [{ spaceId: "space-a", credentialId: null }],
            ),
          ],
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects a policy that omits a required foreign-key column", () => {
    expect(() =>
      assertCapturedForeignKeys(
        [fk],
        new Map([
          ["spaces", captured(["id"], ["id"], [{ id: "space-a" }])],
          ["bots", captured(["id"], ["id"], [{ id: "bot-a" }])],
        ]),
      ),
    ).toThrow(/omits a foreign-key column/i);
  });
});
