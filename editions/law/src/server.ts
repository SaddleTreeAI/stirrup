import { defineServerEdition } from "@rakazo/edition-sdk";
import { lawCaseTools } from "./server/case-library-tools.js";
import {
  lawBotAccess,
  lawTurnNote,
  limitLawTeammates,
  saveLawReviewDraftHook,
} from "./server/cases.js";
import { applyLawChatPin, assertLawDeploymentChatPin } from "./server/chat-pin.js";
import { LawMockAgentRuntime, lawMockEnabled } from "./server/mock-runtime.js";
import { mountLawRoutes } from "./server/routes.js";
import { lawStreamsProgress } from "./server/streams-progress.js";

export const lawEdition = defineServerEdition({
  id: "law",
  onProcessStart: applyLawChatPin,
  mountRoutes: (app, deps) => mountLawRoutes(app, deps),
  agentRuntime: () => (lawMockEnabled() ? new LawMockAgentRuntime() : undefined),
  afterBootstrap: assertLawDeploymentChatPin,
  botAccess: lawBotAccess,
  runHooks: {
    turnNote: lawTurnNote,
    limitTeammates: limitLawTeammates,
    onReplyFinalized: saveLawReviewDraftHook,
    streamsProgress: lawStreamsProgress,
    tools: lawCaseTools,
  },
});
