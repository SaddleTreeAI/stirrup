// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Law media sidecar entry.
 *
 * Run mechanism (chosen for M0): standalone TypeScript entry under
 * editions/law/src/server/media/main.ts. Locally `media:dev` / `media:doctor`
 * run it with tsx (same as the edition seed). In the media image (derived
 * FROM the law server image) the ENTRYPOINT installs and uses tsx to execute
 * this file — no core change, no committed dist. Api/worker still bundle
 * edition code via build-server.mjs; the sidecar is a second process that
 * imports the same workspace packages from source.
 */
import { hostname } from "node:os";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { asSystem, createDb } from "@rakazo/db";
import { createServiceLogger, getLogger, installLogger } from "@rakazo/logging";
import { formatDoctorLines, runDoctor } from "./doctor.js";
import {
  createMediaEngine,
  installMediaSignals,
  mediaConcurrency,
  mediaStaleMinutes,
  mediaTmpRoot,
} from "./engine.js";
import { handlers } from "./handlers/index.js";
import { createPrismaJobStore } from "./job-store.js";
import { createProcessRunner } from "./runner.js";
import { createHandlerIo, createMediaArtifactStore } from "./store.js";

async function runDoctorCli(): Promise<number> {
  const report = await runDoctor();
  for (const line of formatDoctorLines(report)) {
    console.log(line);
  }
  return report.ok ? 0 : 1;
}

async function runLoop(): Promise<void> {
  loadRootEnv();
  installLogger(createServiceLogger({ service: "law-media" }));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const { prisma, pool } = createDb(databaseUrl, {
    applicationName: "law-media",
  });
  const system = asSystem(prisma, "law media sidecar");
  const artifacts = createMediaArtifactStore(system);
  const store = createPrismaJobStore(system);
  const runner = createProcessRunner();
  const log = {
    info: (message: string, fields?: Record<string, unknown>) => getLogger().info(message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => getLogger().warn(message, fields),
    error: (message: string, fields?: Record<string, unknown>) =>
      getLogger().error(message, fields),
  };

  const engine = createMediaEngine({
    store,
    prisma: system,
    runner,
    handlers,
    workerId: process.env.LAW_MEDIA_WORKER_ID?.trim() || `media-${hostname()}`,
    concurrency: mediaConcurrency(),
    staleMinutes: mediaStaleMinutes(),
    tmpRoot: mediaTmpRoot(),
    log,
    createHandlerIo: (input) => createHandlerIo({ prisma: system, artifacts }, input),
  });

  const removeSignals = installMediaSignals(engine, log);
  log.info("law media sidecar starting", {
    workerId: engine.workerId,
    concurrency: mediaConcurrency(),
    staleMinutes: mediaStaleMinutes(),
  });

  try {
    await engine.start();
  } finally {
    removeSignals();
    await prisma.$disconnect();
    await pool.end();
  }
}

const arg = process.argv[2]?.trim();
const wantsDoctor = arg === "media:doctor" || arg === "doctor";

if (wantsDoctor) {
  process.exitCode = await runDoctorCli();
} else {
  await runLoop();
}
