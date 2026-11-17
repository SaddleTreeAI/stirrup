import { describe, expect, it } from "vitest";
import { isPlatformCompanyUser } from "./platform-company-space.js";

describe("platform company enrollment", () => {
  it("requires verification and explicit monitoring consent for non-owner accounts", () => {
    expect(
      isPlatformCompanyUser({
        id: "legacy-member",
        platformRole: "member",
        platformMonitoringAcceptedAt: null,
        emailVerified: true,
        deactivatedAt: null,
      }),
    ).toBe(false);
    expect(
      isPlatformCompanyUser({
        id: "invited-member",
        platformRole: "member",
        platformMonitoringAcceptedAt: new Date(),
        emailVerified: true,
        deactivatedAt: null,
      }),
    ).toBe(true);
  });

  it("allows only an active, verified owner to bootstrap without staff consent", () => {
    expect(
      isPlatformCompanyUser({
        id: "owner",
        platformRole: "owner",
        platformMonitoringAcceptedAt: null,
        emailVerified: true,
        deactivatedAt: null,
      }),
    ).toBe(true);
    expect(
      isPlatformCompanyUser({
        id: "owner",
        platformRole: "owner",
        platformMonitoringAcceptedAt: null,
        emailVerified: false,
        deactivatedAt: null,
      }),
    ).toBe(false);
  });

  it("rejects unverified or deactivated staff even after consent", () => {
    const consented = {
      id: "member",
      platformRole: "member",
      platformMonitoringAcceptedAt: new Date(),
      emailVerified: true,
    };
    expect(isPlatformCompanyUser({ ...consented, deactivatedAt: new Date() })).toBe(false);
    expect(isPlatformCompanyUser({ ...consented, emailVerified: false, deactivatedAt: null })).toBe(
      false,
    );
  });
});
