import type { InferRouterInitialContext } from "@orpc/server";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor, Bot } from "@rakazo/contracts";
import { vi } from "vitest";
import { withModelRoles } from "../../../packages/adapters/src/testing/model-roles.js";
import type { RouterDeps } from "./router.js";
import {
  createRouter as createRouterWith,
  enqueueBotIntroRun as enqueueBotIntroRunWith,
} from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

export { mainRole, withModelRoles } from "../../../packages/adapters/src/testing/model-roles.js";

const withRoleDeps = (deps: RouterDeps) => {
  // Existing route fixtures represent an ordinary deployment unless they explicitly
  // configure company mode. Keep an explicit settings mock supplied by a test.
  const prisma = deps.prisma ?? ({} as RouterDeps["prisma"]);
  if (!prisma.deploymentSettings?.findUnique) {
    Object.assign(prisma, {
      deploymentSettings: {
        ...prisma.deploymentSettings,
        findUnique: vi.fn(async () => null),
      },
    });
  }
  withModelRoles(prisma);
  if (!deps.prisma) deps.prisma = prisma;
  return deps;
};
export const createRouter = (deps: RouterDeps) => createRouterWith(withRoleDeps(deps));
/** A handler that answers errors as the app does, so a domain error keeps its own status. */
export const appHandler = (deps: RouterDeps) =>
  new RPCHandler(createRouter(deps), {
    clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
  });
export const enqueueBotIntroRun = (deps: RouterDeps, ...rest: [Actor, Bot]) =>
  enqueueBotIntroRunWith(withRoleDeps(deps), ...rest);

export type RouterHandler = RPCHandler<InferRouterInitialContext<ReturnType<typeof createRouter>>>;

// Every path these tests call is routed, so a missing response is a broken test.
export async function handle(handler: RouterHandler, ...args: Parameters<RouterHandler["handle"]>) {
  const { response } = await handler.handle(...args);
  if (!response) throw new Error("no response");
  return response;
}
