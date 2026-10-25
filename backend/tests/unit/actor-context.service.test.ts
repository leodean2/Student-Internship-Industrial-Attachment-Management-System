import { describe, expect, it } from "vitest";
import { findOrganizationAffiliation, hasAnyRole, hasRole } from "../../src/modules/auth/actor-context";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import { SYSTEM_ID, caughtAsync, seededRepo } from "./helpers";

const service = () => new ActorContextService(seededRepo());

describe("ActorContext loading (Decision #51)", () => {
  it("builds the context from database state for an active student", async () => {
    const actor = await service().load("stu");
    expect(actor.userId).toBe("stu");
    expect(actor.status).toBe("ACTIVE");
    expect([...actor.roles]).toEqual(["STUDENT"]);
    expect(actor.profileIds.student).toBe("sp1");
    expect(actor.profileIds.admin).toBeUndefined();
    expect(actor.profileIds.organizationSupervisor).toEqual([]);
  });

  it("supports a user holding several roles and several organization affiliations (#43)", async () => {
    const actor = await service().load("multi");
    expect(hasRole(actor, "UNIVERSITY_SUPERVISOR")).toBe(true);
    expect(hasRole(actor, "ORGANIZATION_SUPERVISOR")).toBe(true);
    expect(hasRole(actor, "ADMIN")).toBe(false);
    expect(hasAnyRole(actor, ["ADMIN", "ORGANIZATION_SUPERVISOR"])).toBe(true);
    expect(actor.profileIds.organizationSupervisor).toEqual([
      { profileId: "osp-a", organizationId: "org-a" },
      { profileId: "osp-b", organizationId: "org-b" },
    ]);
  });

  it("scopes organization-supervisor authority by (user, organization), never by user alone (#62)", async () => {
    const actor = await service().load("multi");
    expect(findOrganizationAffiliation(actor, "org-b")).toEqual({ profileId: "osp-b", organizationId: "org-b" });
    expect(findOrganizationAffiliation(actor, "org-z")).toBeUndefined();
  });

  it("rejects an unknown user as UNAUTHENTICATED", async () => {
    const err = await caughtAsync(() => service().load("nobody"));
    expect(err).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("rejects a deactivated account as ACCOUNT_INACTIVE", async () => {
    expect(await caughtAsync(() => service().load("deactivated"))).toMatchObject({ status: 401, code: "ACCOUNT_INACTIVE" });
  });

  it("rejects an unverified account as ACCOUNT_INACTIVE", async () => {
    expect(await caughtAsync(() => service().load("pending"))).toMatchObject({ status: 401, code: "ACCOUNT_INACTIVE" });
  });

  it("rejects the SYSTEM sentinel (ACTIVE but no roles) exactly like an unknown user (#69)", async () => {
    const sys = await caughtAsync(() => service().load(SYSTEM_ID));
    const unknown = await caughtAsync(() => service().load("nobody"));
    expect(sys).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(sys.message).toBe(unknown.message); // indistinguishable: does not reveal the sentinel exists
  });
});
