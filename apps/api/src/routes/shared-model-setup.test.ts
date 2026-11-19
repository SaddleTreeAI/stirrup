import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEdition } from "../edition/active.js";
import type { RouterDeps } from "../router.js";
import { modelSetup } from "./shared.js";

vi.mock("../edition/active.js", () => ({
  getEdition: vi.fn(() => ({})),
}));

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  resolveMemberMainModel: vi.fn(async () => null),
}));

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

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
  } as unknown as RouterDeps;
}

function scriptedEdition(scripted: boolean | undefined) {
  const agentRuntime = vi.fn(() => ({
    describe: () => (scripted === undefined ? {} : { capabilities: { scripted } }),
  }));
  return { agentRuntime };
}

function stubEdition(value: object) {
  vi.mocked(getEdition).mockReturnValue(value as unknown as ReturnType<typeof getEdition>);
}

beforeEach(() => {
  vi.mocked(getEdition).mockReset();
  stubEdition({});
});

describe("modelSetup needsModel (scripted edition runtime)", () => {
  it.each([
    {
      name: "scripted edition runtime skips the model gate",
      envRuntime: "pi" as const,
      edition: () => scriptedEdition(true),
      deploymentModelConfigured: false,
      needsModel: false,
    },
    {
      name: "non-scripted edition runtime still needs a model",
      envRuntime: "pi" as const,
      edition: () => scriptedEdition(false),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "missing capabilities still needs a model",
      envRuntime: "pi" as const,
      edition: () => scriptedEdition(undefined),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "edition without agentRuntime still needs a model",
      envRuntime: "pi" as const,
      edition: () => ({}),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "agentRuntime returning undefined still needs a model",
      envRuntime: "pi" as const,
      edition: () => ({ agentRuntime: () => undefined }),
      deploymentModelConfigured: false,
      needsModel: true,
    },
    {
      name: "env scripted runtime skips the model gate without an edition",
      envRuntime: "scripted" as const,
      edition: () => scriptedEdition(false),
      deploymentModelConfigured: false,
      needsModel: false,
    },
  ])("$name", async ({ envRuntime, edition, deploymentModelConfigured, needsModel }) => {
    stubEdition(edition());
    await expect(
      modelSetup(deps({ agentRuntime: envRuntime, deploymentModelConfigured }), actor),
    ).resolves.toMatchObject({ needsModel });
  });

  it("keeps needsModel false when a deployment model is configured, asking agentRuntime once", async () => {
    const edition = scriptedEdition(true);
    stubEdition(edition);
    await expect(
      modelSetup(deps({ agentRuntime: "pi", deploymentModelConfigured: true }), actor),
    ).resolves.toMatchObject({ needsModel: false });
    expect(edition.agentRuntime).toHaveBeenCalledOnce();
  });
});
