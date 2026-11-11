import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Errors } from "../../src/shared/errors";
import { createApp } from "../../src/app";
import type {
  RegistrationReviewService,
  ReviewItem,
} from "../../src/modules/registration-review/registration-review.service";
import { buildTestApp } from "./helpers";

const PATH = "/api/v1/registration-reviews";
const PROFILE_ID = "c1d30000-0000-4000-8000-000000000001";

function build() {
  const ctx = buildTestApp();
  const item = {
    profileId: PROFILE_ID,
    status: "PENDING",
    registrationNumber: "CIT-221-001/2024",
    rosterMatch: "found",
  };
  const service = {
    list: vi.fn(async (actor) => {
      if (actor.userId === "adm" || actor.userId === "stu") throw Errors.forbidden();
      return [item];
    }),
    get: vi.fn(async () => ({ ...item, history: [] })),
    confirm: vi.fn(async () => ({ profileId: PROFILE_ID, status: "CONFIRMED", decidedAt: new Date() })),
    reject: vi.fn(async () => ({ profileId: PROFILE_ID, status: "REJECTED", decidedAt: new Date() })),
    correct: vi.fn(async () => ({ profileId: PROFILE_ID, status: "PENDING", decidedAt: null })),
  } as unknown as RegistrationReviewService;
  const app = createApp({
    logger: ctx.logger,
    corsOrigins: ["https://app.example.test"],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    registrationReviews: service,
  });
  const as = (userId: string) => ({ Authorization: `Bearer ${ctx.tokens.sign(userId)}` });
  return { app, as, service };
}

describe("registration review routes", () => {
  it("authenticates, then relies on the assignment policy rather than an ADMIN role", async () => {
    const { app, as, service } = build();
    expect((await request(app).get(PATH)).status).toBe(401);
    expect((await request(app).get(PATH).set(as("adm"))).status).toBe(403);
    expect((await request(app).get(PATH).set(as("stu"))).status).toBe(403);

    const response = await request(app).get(PATH).set(as("multi"));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.items).toHaveLength(1);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "multi" }),
      { status: "PENDING", limit: 51 },
    );
    expect(response.body.nextCursor).toBeNull();
  });

  it("only returns a next cursor when a lookahead row exists", async () => {
    const { app, as, service } = build();
    const rows: ReviewItem[] = Array.from({ length: 3 }, (_, index) => ({
      profileId: `c1d30000-0000-4000-8000-00000000000${index + 1}`,
      userId: `student-${index}`,
      name: `Student ${index}`,
      email: `student-${index}@example.test`,
      emailVerifiedAt: null,
      registrationNumber: null,
      rejectedRegistrationNumber: null,
      departmentCode: "CIT",
      status: "PENDING",
      submittedAt: new Date("2026-11-09T08:00:00.000Z"),
      decidedAt: null,
      decidedByUserId: null,
      decisionBasis: null,
      decisionReason: null,
      rosterMatch: null,
    }));
    vi.mocked(service.list).mockResolvedValueOnce(rows);

    const response = await request(app).get(`${PATH}?limit=2`).set(as("multi"));
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.nextCursor).toBe(rows[1]!.profileId);
  });

  it("validates ids, list filters, correction inputs and decision bodies", async () => {
    const { app, as, service } = build();
    expect((await request(app).get(`${PATH}/not-a-uuid`).set(as("multi"))).status).toBe(400);
    expect((await request(app).get(`${PATH}?status=DONE`).set(as("multi"))).status).toBe(400);
    expect((await request(app).post(`${PATH}/${PROFILE_ID}/confirm`).set(as("multi")).send({ basis: " " })).status)
      .toBe(400);
    expect((await request(app).post(`${PATH}/${PROFILE_ID}/reject`).set(as("multi")).send({ reason: "short" })).status)
      .toBe(400);
    expect((await request(app).post(`${PATH}/${PROFILE_ID}/correct`).set(as("multi")).send({
      registrationNumber: "CIT-221-002/2024",
      departmentCode: "BUS",
    })).status).toBe(400);
    expect(service.confirm).not.toHaveBeenCalled();
    expect(service.reject).not.toHaveBeenCalled();
    expect(service.correct).not.toHaveBeenCalled();
  });

  it("dispatches valid decision requests with the authenticated actor", async () => {
    const { app, as, service } = build();
    const confirmed = await request(app)
      .post(`${PATH}/${PROFILE_ID}/confirm`)
      .set(as("multi"))
      .send({ basis: "verified against the roster" });
    expect(confirmed.status).toBe(200);
    expect(service.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "multi" }),
      PROFILE_ID,
      { basis: "verified against the roster" },
    );

    const rejected = await request(app)
      .post(`${PATH}/${PROFILE_ID}/reject`)
      .set(as("multi"))
      .send({ reason: "registration is not on the roster" });
    expect(rejected.status).toBe(200);

    const corrected = await request(app)
      .post(`${PATH}/${PROFILE_ID}/correct`)
      .set(as("multi"))
      .send({ registrationNumber: " cit-221-029/2024 " });
    expect(corrected.status).toBe(200);
    expect(service.correct).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "multi" }),
      PROFILE_ID,
      { registrationNumber: "CIT-221-029/2024" },
    );
  });
});
