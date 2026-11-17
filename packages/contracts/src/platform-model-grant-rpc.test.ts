import { describe, expect, it } from "vitest";
import { appContract } from "./rpc.js";

describe("company model grant RPC", () => {
  it("defaults new grants to the configured monthly user budget and honors opt-out", () => {
    const input = appContract.platformAdmin.providers.setGrant["~orpc"].inputSchema;
    if (!input) throw new Error("setGrant input schema missing");
    const base = {
      userId: "user-1",
      provider: "openrouter",
      enabled: true,
      allowedModelIds: ["model-a"],
    };

    expect(input.parse(base)).toMatchObject({ countsTowardUserBudget: true });
    expect(input.parse({ ...base, countsTowardUserBudget: false })).toMatchObject({
      countsTowardUserBudget: false,
    });
  });
});
