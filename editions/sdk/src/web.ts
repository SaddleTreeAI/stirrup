import type { ComponentType, ReactNode } from "react";

/** Minimal sidebar group shape editions may transform. */
export type SidebarGroupLike = {
  key: string;
  title: string | null;
  bots: ReadonlyArray<{ chat: { id: string } }>;
};

/** Minimal bot shape for create-menu filtering. */
export type CreateBotLike = {
  id: string;
};

export type ShellExtension = {
  transformSidebarGroups?: <G extends SidebarGroupLike>(groups: readonly G[]) => G[];
  filterCreateMenuBots?: <T extends CreateBotLike>(bots: readonly T[]) => T[];
  onBotCreated?: (bot: { id: string }) => Promise<void>;
};

export type WebEdition = {
  id: string;
  hideStarPrompt?: boolean;
  ShellProvider?: ComponentType<{ children: ReactNode }>;
  ChromeFrame?: ComponentType<{ children: ReactNode }>;
  SidebarLeading?: ComponentType;
  MainAside?: ComponentType;
  useShellExtension: () => ShellExtension;
};

/** Identity helper that fills optional web edition defaults. */
export function defineWebEdition(edition: WebEdition): WebEdition {
  return {
    hideStarPrompt: false,
    ...edition,
  };
}
