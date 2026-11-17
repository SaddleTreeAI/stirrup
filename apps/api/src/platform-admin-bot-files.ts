import { createAdapterContext } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";
import { resolvePlatformBotFile } from "./platform-admin-bots.js";
import type { RouterDeps } from "./router.js";

type PlatformFileDeps = Pick<RouterDeps, "prisma" | "artifacts"> & {
  sessionActor: (request: Request) => Promise<{ userId: string; spaceId: string } | null>;
};

function contentDispositionFilename(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_").slice(0, 180) || "download";
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function safeContentType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim() ?? "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream";
}

function httpStatus(error: ClientError): number {
  switch (error.kind) {
    case "BAD_REQUEST":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "TOO_MANY_REQUESTS":
      return 429;
    case "SERVICE_UNAVAILABLE":
      return 503;
  }
}

/** Authenticated owner inspection download that streams decrypted bytes without base64 buffering. */
export function mountPlatformAdminBotFileRoute(app: Hono, deps: PlatformFileDeps): void {
  app.get("/api/platform-admin/bots/:botId/files/:artifactId", async (c) => {
    const actor = await deps.sessionActor(c.req.raw);
    if (!actor) return c.text("Unauthorized", 401, { "cache-control": "no-store" });

    try {
      const botId = c.req.param("botId");
      const artifactId = c.req.param("artifactId");
      const { file } = await resolvePlatformBotFile(deps, actor.userId, botId, artifactId);
      if (!Number.isSafeInteger(file.size) || file.size < 0)
        throw new ClientError("BAD_REQUEST", "File size metadata is invalid");

      const context = createAdapterContext(
        { spaceId: file.spaceId, userId: file.userId },
        botId,
        `platform-inspection-file:${file.id}`,
      );
      const iterator = deps.artifacts.stream(file.storageKey, context)[Symbol.asyncIterator]();
      let bytesSent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await runAsSystem("stream a bot file for platform owner inspection", () =>
              iterator.next(),
            );
            if (next.done) {
              if (bytesSent !== file.size) {
                controller.error(new Error("Stored artifact size did not match its metadata"));
                return;
              }
              controller.close();
              return;
            }
            const chunk = next.value;
            if (bytesSent + chunk.byteLength > file.size) {
              await iterator.return?.();
              controller.error(new Error("Stored artifact exceeded its metadata size"));
              return;
            }
            bytesSent += chunk.byteLength;
            controller.enqueue(chunk);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return?.();
        },
      });
      return new Response(body, {
        headers: {
          "cache-control": "no-store",
          "content-disposition": contentDispositionFilename(file.name),
          "content-length": String(file.size),
          "content-type": safeContentType(file.mimeType),
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof ClientError)
        return new Response(error.message, {
          status: httpStatus(error),
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      throw error;
    }
  });
}
