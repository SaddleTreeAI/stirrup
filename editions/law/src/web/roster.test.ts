// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import type { LawRosterFilter } from "./roster.js";
import { applyLawRoster, chooseLawDefaultRoute, filterLawCreateBots } from "./roster.js";

type Group = {
  key: string;
  title: string | null;
  bots: Array<{ chat: { id: string }; label: string }>;
};

const groups: Group[] = [
  {
    key: "space",
    title: "Space",
    bots: [
      { chat: { id: "case-bot-1" }, label: "Case bot 1" },
      { chat: { id: "case-bot-2" }, label: "Case bot 2" },
      { chat: { id: "general-bot" }, label: "General bot" },
    ],
  },
];

const casesFilter: LawRosterFilter = {
  environment: "cases",
  caseBotIds: ["case-bot-1", "case-bot-2"],
  allCaseBotIds: ["case-bot-1", "case-bot-2"],
};

const generalFilter: LawRosterFilter = {
  environment: "general",
  caseBotIds: [],
  allCaseBotIds: ["case-bot-1", "case-bot-2"],
};

describe("applyLawRoster", () => {
  it("keeps only the open case bots in the cases environment", () => {
    const result = applyLawRoster(groups, casesFilter);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("law-case");
    expect(result[0]?.bots.map((bot) => bot.chat.id)).toEqual(["case-bot-1", "case-bot-2"]);
  });

  it("keeps only non-case bots in the general environment", () => {
    const result = applyLawRoster(groups, generalFilter);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("law-general");
    expect(result[0]?.bots.map((bot) => bot.chat.id)).toEqual(["general-bot"]);
  });

  it("returns a copy of the groups when the filter is null", () => {
    const result = applyLawRoster(groups, null);
    expect(result).toEqual(groups);
    expect(result).not.toBe(groups);
  });

  it("hides every bot while the case list is still loading", () => {
    const result = applyLawRoster(groups, { ...casesFilter, loading: true });
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("law-loading");
    expect(result[0]?.bots).toEqual([]);
  });
});

describe("filterLawCreateBots", () => {
  const bots = [{ id: "case-bot-1" }, { id: "case-bot-2" }, { id: "general-bot" }];

  it("allows only case bots while a case is open", () => {
    expect(filterLawCreateBots(bots, casesFilter).map((bot) => bot.id)).toEqual([
      "case-bot-1",
      "case-bot-2",
    ]);
  });

  it("hides case bots in the general environment", () => {
    expect(filterLawCreateBots(bots, generalFilter).map((bot) => bot.id)).toEqual(["general-bot"]);
  });

  it("returns all bots when the filter is null", () => {
    expect(filterLawCreateBots(bots, null)).toEqual(bots);
  });

  it("offers no bots while the case list is still loading", () => {
    expect(filterLawCreateBots(bots, { ...generalFilter, loading: true })).toEqual([]);
  });
});

describe("chooseLawDefaultRoute", () => {
  const bots = [
    { id: "case-bot-1" },
    { id: "case-bot-2", snoozedUntil: "2999-01-01T00:00:00.000Z" },
    { id: "general-bot" },
  ];

  it("opens the first case bot while cases are selected", () => {
    expect(chooseLawDefaultRoute(casesFilter, bots)).toBe("/app/case-bot-1");
  });

  it("skips a snoozed case bot", () => {
    expect(
      chooseLawDefaultRoute({ ...casesFilter, caseBotIds: ["case-bot-2", "case-bot-1"] }, bots),
    ).toBe("/app/case-bot-1");
  });

  it("opens a non-case bot in the general environment", () => {
    expect(chooseLawDefaultRoute(generalFilter, bots)).toBe("/app/general-bot");
  });

  it("stays on the chatless route when general has no bot of its own", () => {
    expect(chooseLawDefaultRoute(generalFilter, [{ id: "case-bot-1" }])).toBe("/app");
  });

  it("does not pick a case bot before the case list arrives", () => {
    expect(chooseLawDefaultRoute({ ...casesFilter, loading: true }, bots)).toBe("/app");
  });
});
