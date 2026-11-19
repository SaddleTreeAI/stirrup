// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import type { DoctorTool } from "./doctor.js";
import { checkTool, formatDoctorLines, MEDIA_TOOLS, requiredToolIds, runDoctor } from "./doctor.js";
import type { Runner } from "./types.js";

function fakeRunner(
  map: Record<string, { code: number | null; stdout?: string; stderr?: string }>,
): Runner {
  return {
    async run(cmd, args) {
      const key = `${cmd} ${args.join(" ")}`;
      const hit = map[key] ?? map[cmd] ?? ({ code: 127, stdout: "", stderr: "not found" } as const);
      return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
    },
  };
}

describe("doctor version parsing", () => {
  it("parses each known tool version string", async () => {
    const samples: Record<string, string> = {
      ffmpeg: "ffmpeg version 6.1.1-0 Copyright",
      ffprobe: "ffprobe version 6.1.1-0 Copyright",
      pdftotext: "pdftotext version 24.02.0",
      tesseract: "tesseract 5.3.4",
      ocrmypdf: "16.1.0",
      python3: "Python 3.11.2",
    };
    for (const tool of MEDIA_TOOLS.filter((entry) => entry.id in samples)) {
      const line = await checkTool(
        tool,
        fakeRunner({
          [tool.command]: {
            code: tool.id === "pdftotext" ? 99 : 0,
            stderr: samples[tool.id],
            stdout: samples[tool.id],
          },
        }),
        true,
      );
      expect(line.status).toBe("ok");
      expect(line.detail).toMatch(/\d/);
    }
  });

  it("reports MISSING when the command is absent", async () => {
    const tool: DoctorTool = MEDIA_TOOLS.find((entry) => entry.id === "ffmpeg")!;
    const line = await checkTool(tool, fakeRunner({}), true);
    expect(line).toMatchObject({ id: "ffmpeg", status: "MISSING", detail: "MISSING" });
  });

  it("reports MISSING on spawn failure even when stderr mentions the tool name", async () => {
    const tool: DoctorTool = MEDIA_TOOLS.find((entry) => entry.id === "tesseract")!;
    const line = await checkTool(
      tool,
      fakeRunner({
        tesseract: { code: null, stderr: "spawn tesseract ENOENT" },
      }),
      true,
    );
    expect(line).toMatchObject({ id: "tesseract", status: "MISSING", detail: "MISSING" });
  });

  it("honours LAW_MEDIA_REQUIRED_TOOLS and exits unhealthy when a required tool is missing", async () => {
    const report = await runDoctor({
      runner: fakeRunner({
        "python3 --version": { code: 0, stdout: "Python 3.11.2" },
        "nvidia-smi --query-gpu=name --format=csv,noheader": { code: 127 },
      }),
      env: { LAW_MEDIA_REQUIRED_TOOLS: "python3" },
      tools: MEDIA_TOOLS.filter((tool) => tool.id === "python3" || tool.id === "ffmpeg"),
    });
    expect(report.ok).toBe(true);
    expect(formatDoctorLines(report).some((line) => line.startsWith("python3 "))).toBe(true);

    const bad = await runDoctor({
      runner: fakeRunner({}),
      env: { LAW_MEDIA_REQUIRED_TOOLS: "ffmpeg" },
      tools: [MEDIA_TOOLS.find((tool) => tool.id === "ffmpeg")!],
    });
    expect(bad.ok).toBe(false);
    expect(formatDoctorLines(bad)).toContain("ffmpeg MISSING");
  });

  it("defaults the required set", () => {
    expect([...requiredToolIds({})].sort()).toEqual(
      ["ffmpeg", "ffprobe", "ocrmypdf", "pdftotext", "python3", "tesseract"].sort(),
    );
  });
});
