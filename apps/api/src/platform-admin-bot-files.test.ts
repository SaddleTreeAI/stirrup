import { ClientError } from "@rakazo/core";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizePlatformInspection } from "./platform-admin.js";
import { mountPlatformAdminBotFileRoute } from "./platform-admin-bot-files.js";

vi.mock("./platform-admin.js", () => ({
  authorizePlatformInspection: vi.fn(async () => undefined),
}));

const fileRow = {
  id: "artifact-1",
  botId: null,
  groupId: "group-1",
  spaceId: "company-space",
  userId: "member-1",
  name: "field notes (final).txt",
  mimeType: "text/plain; charset=utf-8",
  size: 11 * 1024 * 1024,
  storageKey: "object:artifact-1",
};

function fixture(
  options: { session?: string | null; attached?: boolean; artifactBotId?: string | null } = {},
) {
  const streamed: Uint8Array[] = [];
  const prisma = {
    bot: {
      findUnique: vi.fn(async () => ({
        id: "bot-1",
        userId: "member-1",
        spaceId: "company-space",
      })),
    },
    artifact: {
      findUnique: vi.fn(async () => ({
        ...fileRow,
        botId: options.artifactBotId ?? fileRow.botId,
        groupId: options.artifactBotId ? null : fileRow.groupId,
      })),
    },
    chatGroup: {
      findFirst: vi.fn(async () => (options.attached === false ? null : { id: "group-1" })),
    },
  };
  const artifacts = {
    get: vi.fn(async () => {
      throw new Error("large file must not use the buffering read");
    }),
    stream: vi.fn(async function* (id: string, context: { spaceId: string; botId?: string }) {
      expect(id).toBe(fileRow.storageKey);
      expect(context).toMatchObject({ spaceId: "company-space", botId: "bot-1" });
      for (let index = 0; index < 11; index += 1) {
        const chunk = new Uint8Array(1024 * 1024).fill(index);
        streamed.push(chunk);
        yield chunk;
      }
    }),
  };
  const app = new Hono();
  mountPlatformAdminBotFileRoute(app, {
    prisma: prisma as never,
    artifacts: artifacts as never,
    sessionActor: vi.fn(async () =>
      options.session === null
        ? null
        : { userId: options.session ?? "platform-owner", spaceId: "private" },
    ),
  });
  return { app, prisma, artifacts, streamed };
}

afterEach(() => vi.clearAllMocks());

describe("platform owner bot file streaming route", () => {
  it("streams a large group artifact after owner authorization using the selected bot context", async () => {
    const h = fixture();
    const response = await h.app.request("/api/platform-admin/bots/bot-1/files/artifact-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(fileRow.size));
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''field%20notes%20%28final%29.txt",
    );
    expect(authorizePlatformInspection).toHaveBeenCalledWith(
      h.prisma,
      "platform-owner",
      "member-1",
      "bot-content",
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(fileRow.size);
    expect(bytes[0]).toBe(0);
    expect(bytes[10 * 1024 * 1024]).toBe(10);
    expect(h.streamed).toHaveLength(11);
    expect(h.artifacts.get).not.toHaveBeenCalled();
  });

  it("requires a session and refuses group files that are not attached to the selected bot", async () => {
    const anonymous = fixture({ session: null });
    await expect(
      anonymous.app.request("/api/platform-admin/bots/bot-1/files/artifact-1"),
    ).resolves.toMatchObject({ status: 401 });
    expect(anonymous.prisma.artifact.findUnique).not.toHaveBeenCalled();

    const foreign = fixture({ attached: false });
    await expect(
      foreign.app.request("/api/platform-admin/bots/bot-1/files/artifact-1"),
    ).resolves.toMatchObject({ status: 404 });
    expect(foreign.artifacts.stream).not.toHaveBeenCalled();

    const otherBotFile = fixture({ artifactBotId: "other-bot" });
    await expect(
      otherBotFile.app.request("/api/platform-admin/bots/bot-1/files/artifact-1"),
    ).resolves.toMatchObject({ status: 404 });
    expect(otherBotFile.artifacts.stream).not.toHaveBeenCalled();
  });

  it("refuses administrator inspection before opening the artifact stream", async () => {
    vi.mocked(authorizePlatformInspection).mockRejectedValueOnce(
      new ClientError("FORBIDDEN", "Forbidden"),
    );
    const h = fixture({ session: "admin" });
    const response = await h.app.request("/api/platform-admin/bots/bot-1/files/artifact-1");
    expect(response.status).toBe(403);
    expect(h.prisma.artifact.findUnique).not.toHaveBeenCalled();
    expect(h.artifacts.stream).not.toHaveBeenCalled();
  });

  it("fails a streamed file whose decrypted bytes disagree with declared size", async () => {
    const h = fixture();
    h.artifacts.stream.mockImplementationOnce(async function* () {
      yield new Uint8Array(1);
    });
    const response = await h.app.request("/api/platform-admin/bots/bot-1/files/artifact-1");
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});
