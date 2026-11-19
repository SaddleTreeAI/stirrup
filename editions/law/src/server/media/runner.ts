// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { spawn } from "node:child_process";
import type { Runner, RunResult } from "./types.js";

export const RUNNER_OUTPUT_LIMIT = 64 * 1024;

/** Truncate tool output so logs and job errors never hold whole files. */
export function truncateOutput(text: string, limit = RUNNER_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} bytes]`;
}

/** Real process runner: shells out with optional cwd, timeout, and env. */
export function createProcessRunner(): Runner {
  return {
    run(cmd, args, options = {}) {
      return new Promise<RunResult>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result: RunResult) => {
          if (settled) return;
          settled = true;
          resolve({
            code: result.code,
            stdout: truncateOutput(result.stdout),
            stderr: truncateOutput(result.stderr),
          });
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdout.length < RUNNER_OUTPUT_LIMIT * 2) stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < RUNNER_OUTPUT_LIMIT * 2) stderr += chunk.toString("utf8");
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({
              code: null,
              stdout,
              stderr: `${stderr}\n[timeout after ${options.timeoutMs}ms]`,
            });
          }, options.timeoutMs);
        }
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          finish({
            code: null,
            stdout,
            stderr: truncateOutput(`${stderr}\n${error.message}`),
          });
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          finish({ code, stdout, stderr });
        });
      });
    },
  };
}
