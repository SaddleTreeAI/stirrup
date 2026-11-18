// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/** Core seam R4: flush scripted progress only for the law mock runtime. */
export function lawStreamsProgress(runtimeId: string | undefined): boolean {
  return runtimeId === "law-mock";
}
