// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

const SPACE_STORAGE_KEY = "rakazo:space-id";
const SPACE_SELECTED_EVENT = "rakazo:space-selected";

export function selectedSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the selected Space and announce it the same way the core shell does. */
export function selectSpace(id: string): boolean {
  try {
    window.localStorage.setItem(SPACE_STORAGE_KEY, id);
    window.dispatchEvent(new Event(SPACE_SELECTED_EVENT));
    return true;
  } catch {
    try {
      return window.localStorage.getItem(SPACE_STORAGE_KEY) === id;
    } catch {
      return false;
    }
  }
}

/**
 * Move into the Space that holds the user's cases. Used when Cases is chosen
 * while the current organization has none — General stays on the current Space.
 */
export function landInCasesSpace(spaceId: string): boolean {
  if (selectedSpaceId() === spaceId) return false;
  if (!selectSpace(spaceId)) return false;
  window.location.assign("/app");
  return true;
}

/** Adds `x-rakazo-space-id` when a space is selected. */
export function withSpaceHeaders(
  init?: HeadersInit,
  spaceId: string | null = selectedSpaceId(),
): Headers {
  const headers = new Headers(init);
  if (spaceId) headers.set("x-rakazo-space-id", spaceId);
  else headers.delete("x-rakazo-space-id");
  return headers;
}
