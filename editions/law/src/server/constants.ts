// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/** Chat provider id pinned for law edition bots (shared with C3). */
export const LAW_CHAT_PROVIDER = "openrouter";

/** Chat model id pinned for law edition bots (shared with C3). */
export const LAW_CHAT_MODEL_ID = "qwen/qwen3.8-27b";

/** Days a soft-deleted case is kept before CASE2 may purge it. 0 disables auto-purge. */
export const DEFAULT_LAW_CASE_RETENTION_DAYS = 30;

/** Soft-delete retention window. Non-finite or negative values fall back to the default. */
export function lawCaseRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAW_CASE_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_LAW_CASE_RETENTION_DAYS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_LAW_CASE_RETENTION_DAYS;
  return Math.floor(value);
}
