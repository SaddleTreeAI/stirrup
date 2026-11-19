import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";

const getEdition = vi.hoisted(() => vi.fn());

vi.mock("../edition/active.js", () => ({ getEdition }));

vi.mock("@rakazo/adapters", async (importOriginal) => {
  const adapters = await importOriginal<typeof import("@rakazo/adapters")>();
  return { ...adapters, resolveMemberMainModel: vi.fn(async () => null) };
});

import { modelSetup } from "./shared.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

function scriptedRuntime(capabilities: Record<string, unknown> | undefined) {
  return vi.fn(() => ({
    describe: () => (capabilities === undefined ? {} : { capabilities }),
  }));
}

function deps(options: { agentRuntime: string; deploymentModelConfigured?: boolean }): RouterDeps {
  return {
    prisma: {
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient,
    env: {
      agentRuntime: options.agentRuntime,
      defaultProvider: "openrouter",
      defaultModel: "test-model",
      deploymentModelConfigured: options.deploymentModelConfigured ?? false,
    },
    dataDir: "/tmp/rakazo-model-setup-test",
  } as unknown as RouterDeps;
}

describe("modelSetup needsModel (edition seam S6)", () => {
  beforeEach(() => {
    getEdition.mockReset();
  });

  it.each([
    {
      name: "scripted edition runtime skips the model gate",
      agentRuntime: "pi",
      edition: () => ({ agentRuntime: scriptedRuntime({ scripted: true }) }),
      deploymentModelConfigured: false,
      needsModel: false,
    },
    {
      name: "non-scripted edition capabilities still need a model",
      agentRuntime: "pi",
      edition: () => ({ agentRuntime: scriptedRuntime({ scripted: false }) }),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "missing capabilities still need a model",
      agentRuntime: "pi",
      edition: () => ({ agentRuntime: scriptedRuntime(undefined) }),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "edition without agentRuntime still needs a model",
      agentRuntime: "pi",
      edition: () => ({}),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "agentRuntime that returns undefined still needs a model",
      agentRuntime: "pi",
      edition: () => ({ agentRuntime: () => undefined }),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "env scripted runtime skips the model gate without an edition",
      agentRuntime: "scripted",
      edition: () => ({ agentRuntime: scriptedRuntime({ scripted: false }) }),
      deploymentModelConfigured: false,
      needsModel: false,
    },
  ])("$name", async (row) => {
    getEdition.mockReturnValue(row.edition());
    const result = await modelSetup(
      deps({
        agentRuntime: row.agentRuntime,
        deploymentModelConfigured: row.deploymentModelConfigured,
      }),
      actor,
    );
    expect(result.needsModel).toBe(row.needsModel);
  });

  it("a deployment model wins even when the edition is scripted, and agentRuntime runs once", async () => {
    const agentRuntime = scriptedRuntime({ scripted: true });
    getEdition.mockReturnValue({ agentRuntime });
    const result = await modelSetup(
      deps({ agentRuntime: "pi", deploymentModelConfigured: true }),
      actor,
    );
    expect(result.needsModel).toBe(false);
    expect(agentRuntime).toHaveBeenCalledTimes(1);
  });
});
