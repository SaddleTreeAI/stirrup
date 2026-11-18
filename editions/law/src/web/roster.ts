// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

export type LawEnvironment = "general" | "cases";

export interface LawRosterFilter {
  environment: LawEnvironment;
  /** Selected case, in role order. Empty in the general environment. */
  caseBotIds: readonly string[];
  /** Every case bot, including the other cases, which stay hidden. */
  allCaseBotIds: readonly string[];
  /** True until the first case list for this space has arrived. Bots stay hidden. */
  loading?: boolean;
}

/**
 * Case environment: only the open case's bots.
 * General Stirrup: only bots that are not on any case.
 */
export function applyLawRoster<
  T extends {
    key: string;
    title: string | null;
    bots: ReadonlyArray<{ chat: { id: string } }>;
  },
>(groups: readonly T[], filter: LawRosterFilter | null): T[] {
  if (!filter || groups.length === 0) return [...groups];
  const items = groups.flatMap((group) => group.bots);
  const byId = new Map(items.map((item) => [item.chat.id, item]));
  const template = groups[0]!;
  const section = (key: string, title: string | null, bots: T["bots"][number][]): T =>
    ({
      ...template,
      key,
      title,
      subtitle: undefined,
      bots,
      sectionId: null,
      canOpenSpaceSettings: false,
      canRenameSpace: false,
      canDeleteSpace: false,
    }) as T;

  if (filter.loading) return [section("law-loading", null, [])];

  if (filter.environment === "general") {
    const hidden = new Set(filter.allCaseBotIds);
    const generalBots = items.filter((item) => !hidden.has(item.chat.id));
    return [section("law-general", null, generalBots)];
  }

  const caseBots = filter.caseBotIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  return [section("law-case", null, caseBots)];
}

/** Bots the create menu may open while a law environment is active. */
export function filterLawCreateBots<T extends { id: string }>(
  bots: readonly T[],
  filter: LawRosterFilter | null,
): T[] {
  if (!filter) return [...bots];
  if (filter.loading) return [];
  if (filter.environment === "general") {
    const hidden = new Set(filter.allCaseBotIds);
    return bots.filter((bot) => !hidden.has(bot.id));
  }
  const allowed = new Set(filter.caseBotIds);
  return bots.filter((bot) => allowed.has(bot.id));
}
