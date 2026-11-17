import { describe, expect, it } from "vitest";
import { conflictBatches, primaryKeyConflictQuery, quotedIdentifier } from "./sql.js";

describe("account-transfer conflict checks", () => {
  it("builds parameterized conflicts for camelCase composite primary keys", () => {
    const query = primaryKeyConflictQuery(
      "space_model_role_choices",
      ["spaceId", "userId", "role"],
      [
        { spaceId: "space-a", userId: "user-a", role: "default" },
        { spaceId: "space-a", userId: "user-b", role: "default" },
      ],
      [
        { name: "spaceId", dataType: "text", udtName: "text", nullable: false, hasDefault: false },
        { name: "userId", dataType: "text", udtName: "text", nullable: false, hasDefault: false },
        { name: "role", dataType: "text", udtName: "text", nullable: false, hasDefault: false },
      ],
    );
    expect(query.sql).toContain('target."spaceId"=source."spaceId"');
    expect(query.sql).toContain('target."userId"=source."userId"');
    expect(query.sql).toContain('target."role"=source."role"');
    expect(query.values).toEqual(["space-a", "user-a", "default", "space-a", "user-b", "default"]);
    expect(query.sql.match(/\$\d+/g)).toEqual(["$1", "$2", "$3", "$4", "$5", "$6"]);
  });

  it("chunks large imports below Postgres parameter limits", () => {
    const rows = Array.from({ length: 20_000 }, (_, id) => ({ id, threadId: `thread-${id}` }));
    const batches = conflictBatches(rows, ["id", "threadId"], 32_000);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.length)).toEqual([16_000, 4_000]);
    expect(Math.max(...batches.map((batch) => batch.length * 2))).toBeLessThanOrEqual(32_000);
  });

  it("quotes only ordinary database identifiers, including mixed-case columns", () => {
    expect(quotedIdentifier("threadId")).toBe('"threadId"');
    expect(() => quotedIdentifier('id"; DROP TABLE user; --')).toThrow(/Unsafe/);
  });
});
