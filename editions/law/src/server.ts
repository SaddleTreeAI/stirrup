import { defineServerEdition } from "@rakazo/edition-sdk";
import { lawTurnNote, limitLawTeammates, saveLawReviewDraftHook } from "./server/cases.js";
import { mountLawRoutes } from "./server/routes.js";

export const lawEdition = defineServerEdition({
  id: "law",
  mountRoutes: (app, deps) => mountLawRoutes(app, deps),
  runHooks: {
    turnNote: lawTurnNote,
    limitTeammates: limitLawTeammates,
    onReplyFinalized: saveLawReviewDraftHook,
  },
});
