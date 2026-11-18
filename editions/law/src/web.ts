// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { defineWebEdition } from "@rakazo/edition-sdk";
import { useMemo } from "react";
import { applyLawRoster, chooseLawDefaultRoute, filterLawCreateBots } from "./web/roster.js";
import {
  LawCaseColumn,
  LawCaseTabs,
  LawChromeFrame,
  LawProvider,
  useLawShell,
} from "./web/shell.js";

export const edition = defineWebEdition({
  id: "law",
  hideStarPrompt: true,
  ShellProvider: LawProvider,
  ChromeFrame: LawChromeFrame,
  SidebarLeading: LawCaseTabs,
  MainAside: LawCaseColumn,
  useShellExtension: () => {
    const law = useLawShell();
    return useMemo(
      () => ({
        transformSidebarGroups: (groups) => {
          law.noteSidebarBotIds(groups.flatMap((group) => group.bots.map((bot) => bot.chat.id)));
          return applyLawRoster(groups, law.roster);
        },
        filterCreateMenuBots: (bots) => filterLawCreateBots(bots, law.roster),
        chooseDefaultRoute: (bots, groups) => chooseLawDefaultRoute(law.roster, bots, groups),
        onBotCreated: async (bot) => {
          if (law.environment === "cases" && law.selected)
            await law.attachBot(bot.id).catch(() => undefined);
        },
      }),
      [law.roster, law.environment, law.selected, law.attachBot, law.noteSidebarBotIds],
    );
  },
});

export default edition;
