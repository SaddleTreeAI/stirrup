// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const editionState = vi.hoisted(() => ({
  hideStarPrompt: false,
}));

vi.mock("../../edition", () => ({
  edition: {
    get hideStarPrompt() {
      return editionState.hideStarPrompt;
    },
    useShellExtension: () => ({}),
  },
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", () => {
  const Plain = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  );
  return {
    Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    buttonVariants: () => "",
    toast: { custom: () => {}, dismiss: () => {} },
    InputGroup: Plain,
    InputGroupAddon: Plain,
    InputGroupButton: Plain,
    InputGroupInput: (props: Record<string, unknown>) => <input {...props} />,
    Sidebar: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <aside data-testid="bots-sidebar" {...props}>
        {children}
      </aside>
    ),
  };
});

vi.mock("../../components/CreateOrganizationDialog", () => ({
  CreateOrganizationDialog: () => null,
}));
vi.mock("../../components/InviteDialog", () => ({ InviteDialog: () => null }));
vi.mock("../../components/PasskeyOffer", () => ({ PasskeyOffer: () => null }));
vi.mock("../../components/PlanUsage", () => ({
  PlanUsageRows: () => null,
  useUsageHint: () => null,
}));
vi.mock("../../components/PlatformAdminLink", () => ({ PlatformAdminLink: () => null }));
vi.mock("../../components/SidebarFooter", () => ({ SidebarFooter: () => null }));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: null, showPlans: () => undefined }),
}));
vi.mock("../../lib/organizations", () => ({
  switchOrganization: () => undefined,
  useOrganizations: () => ({ organizations: [], activeOrganizationId: null }),
}));
vi.mock("../../lib/query", () => ({ useQueryUserId: () => "user-1" }));
vi.mock("../../lib/sign-out", () => ({
  useSignOut: () => ({ signingOut: false, logOut: async () => undefined }),
}));
vi.mock("../ActivityList", () => ({ ActivityList: () => null }));
vi.mock("../SpaceSearch", () => ({ SpaceSearchResults: () => null }));
vi.mock("./more-unreads", () => ({
  MoreUnreads: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./sidebar-header", () => ({ SidebarHeader: () => <div data-testid="sidebar-header" /> }));

import { GitHubStarPrompt } from "../../components/GitHubStarPrompt";
import { ShellSidebar } from "./shell-sidebar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  editionState.hideStarPrompt = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const noop = () => undefined;

function renderSidebar(leading?: ReactNode) {
  act(() =>
    root.render(
      <ShellSidebar
        isMobile={false}
        mobileOpen={false}
        setMobileOpen={noop}
        density="comfortable"
        collapsed={false}
        mini={false}
        setCollapsedPref={noop}
        createMenuOpen={false}
        setCreateMenuOpen={noop}
        search={
          {
            query: "",
            setQuery: noop,
            searchOpen: false,
            setSearchOpen: noop,
            searchHits: [],
            searchLoading: false,
            searchError: null,
            retrySearch: noop,
            showSpaceSearch: false,
            jumpToSearchHit: noop,
            activityMode: false,
            toggleActivityMode: noop,
            activityFilters: { query: "" },
            setActivityFilters: noop,
            activityFiltersExpanded: false,
            setActivityFiltersExpanded: noop,
            activityFiltersId: "activity-filters",
            activityFilterCount: 0,
          } as never
        }
        bots={[]}
        groups={[]}
        collapsedSidebarSections={new Set()}
        toggleSidebarSection={noop}
        setPanel={noop}
        navigate={noop}
        setNewSpaceOpen={noop}
        setCreateBotOpen={noop}
        chatMenu={
          {
            menu: null,
            setMenu: noop,
            content: null,
            has: () => false,
          } as never
        }
        roster={<div data-testid="roster" />}
        archived={null}
        footerLogos={[]}
        user={undefined}
        boardEnabled={false}
        navLinks={[]}
        openSettings={noop}
        openIntegrations={noop}
        openSkills={noop}
        openSpaceChat={noop}
        leading={leading}
      />,
    ),
  );
}

describe("edition seam W4 sidebar leading", () => {
  it("renders leading when given", () => {
    renderSidebar(<div data-testid="edition-leading">tabs</div>);
    expect(container.querySelector('[data-testid="edition-leading"]')).not.toBeNull();
  });

  it("renders nothing extra when leading is omitted", () => {
    renderSidebar();
    expect(container.querySelector('[data-testid="edition-leading"]')).toBeNull();
    expect(container.querySelector('[data-testid="bots-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-header"]')).not.toBeNull();
  });
});

describe("edition seam W7 star prompt", () => {
  it("returns null when hideStarPrompt is true", () => {
    editionState.hideStarPrompt = true;
    act(() => root.render(<GitHubStarPrompt />));
    expect(container.querySelector('[aria-label="Star on GitHub"]')).toBeNull();
  });

  it("renders as before when hideStarPrompt is false", () => {
    editionState.hideStarPrompt = false;
    act(() => root.render(<GitHubStarPrompt />));
    expect(container.querySelector('[aria-label="Star on GitHub"]')).not.toBeNull();
  });
});

describe("edition seam W3 chrome frame identity", () => {
  it("keeps a child mounted across parent re-renders when the frame is module-level", () => {
    // Mirrors Shell.tsx: NoChromeFrame is stable; an inline frame would remount.
    function NoChromeFrame({ children }: { children: ReactNode }) {
      return children;
    }
    let mounts = 0;
    function Child() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div data-testid="frame-child" />;
    }
    function Parent({ tick }: { tick: number }) {
      const ChromeFrame = NoChromeFrame;
      return (
        <ChromeFrame>
          <Child />
          <span data-testid="tick">{tick}</span>
        </ChromeFrame>
      );
    }
    act(() => root.render(<Parent tick={1} />));
    expect(mounts).toBe(1);
    act(() => root.render(<Parent tick={2} />));
    expect(mounts).toBe(1);
    expect(container.querySelector('[data-testid="tick"]')?.textContent).toBe("2");
  });
});
