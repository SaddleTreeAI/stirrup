// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  role: "owner",
  mode: true,
  list: vi.fn(),
  overview: vi.fn(),
  invites: vi.fn(),
  createInvite: vi.fn(),
  setRole: vi.fn(),
  deactivate: vi.fn(),
  reactivate: vi.fn(),
  sendPasswordReset: vi.fn(),
  revokeInvite: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("../lib/rpc", () => {
  const rpc = { platformAdmin: { users: api } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (original) => {
  const actual = await original<typeof Query>();
  const query = (name: string, run: () => unknown) => ({
    key: () => [name],
    queryOptions: () => ({ queryKey: [name], queryFn: run }),
  });
  return {
    ...actual,
    useSpaceQueries: () => ({
      me: query("me", async () => ({ platformRole: api.role, platformMode: api.mode })),
      platformAdmin: {
        overview: query("overview", api.overview),
        users: { list: query("people", api.list), invites: query("invites", api.invites) },
      },
    }),
  };
});
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("./CompanyProvidersPanel", () => ({ CompanyProvidersPanel: () => null }));
vi.mock("./PlatformOwnerBotInspection", () => ({ PlatformOwnerBotInspection: () => null }));
vi.mock("../components/PageLoading", () => ({ PageLoading: () => null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: Pass,
    Field: Pass,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    SectionHeading: Pass,
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? children : null,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    buttonVariants: () => "",
    FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    toast: { error: api.toastError, success: vi.fn() },
  };
});

import type * as Query from "../lib/query";
import { AdminPlatformPage } from "./AdminPlatformPage";

const person = {
  id: "member-one",
  name: "Member One",
  email: "member@example.test",
  role: "member",
  active: true,
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00Z",
  monthlyBudgetUsd: 100,
  monthToDateCostUsd: null,
  monthToDateCalls: 7,
  monthToDateInputTokens: 12,
  monthToDateOutputTokens: 20,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.role = "owner";
  api.mode = true;
  api.list.mockResolvedValue([person]);
  api.invites.mockResolvedValue([]);
  api.overview.mockResolvedValue({
    users: 1,
    activeUsers: 1,
    pendingInvites: 0,
    monthToDateCostUsd: null,
    monthToDateCalls: 7,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <AdminPlatformPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

it("does not fetch platform records for members or servers without company mode", async () => {
  api.role = "member";
  await render();
  await vi.waitFor(() => expect(container.textContent).not.toContain("Administration"));
  expect(api.list).not.toHaveBeenCalled();
  expect(api.overview).not.toHaveBeenCalled();
});

it("shows an admin the people list without owner-only role controls", async () => {
  api.role = "admin";
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Member One"));
  expect(container.textContent).toContain("Unknown");
  await click("Member One");
  expect(container.querySelector('fieldset[aria-label="Role"]')).toBeNull();
  expect(container.textContent).toContain("Send password reset");
});

it("reports a failed suspension and leaves the member's current status visible", async () => {
  api.deactivate.mockRejectedValue(new Error("The account is directory managed"));
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Member One"));
  await click("Member One");
  await click("Suspend account");
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("The account is directory managed"),
  );
  expect(api.deactivate).toHaveBeenCalledWith({ userId: "member-one" });
  expect(container.textContent).toContain("Suspend account");
  expect(container.textContent).not.toContain("Reactivate account");
});
