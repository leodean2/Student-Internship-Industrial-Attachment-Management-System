import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/app";
import type { StudentProfileService, StudentProfileView } from "../../../src/modules/student-profile/student-profile.service";
import { buildTestApp } from "../helpers";

const BASE = "/api/v1/students/me";
const PATH = `${BASE}/profile`;

const SAMPLE_VIEW: StudentProfileView = {
  registration: { name: "Student One", email: "stu@example.test", registrationNumber: "CIT-221-001/2024", status: "CONFIRMED" },
  university: "Example University",
  faculty: "Computing",
  department: "Information Technology",
  course: "BSc IT",
  yearOfStudy: 3,
  phone: "+254712345678",
  expectedGraduation: "2027-06-30",
  isComplete: true,
};

function build() {
  const ctx = buildTestApp();
  const service = {
    get: vi.fn(async () => SAMPLE_VIEW),
    update: vi.fn(async () => ({ ...SAMPLE_VIEW, yearOfStudy: 4 })),
  } as unknown as StudentProfileService;
  const app = createApp({
    logger: ctx.logger,
    corsOrigins: ["https://app.example.test"],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    studentProfile: service,
  });
  const as = (userId: string) => ({ Authorization: `Bearer ${ctx.tokens.sign(userId)}` });
  return { app, as, service };
}

describe("student profile routes", () => {
  it("unauthenticated requests get 401", async () => {
    const { app } = build();
    expect((await request(app).get(PATH)).status).toBe(401);
    expect((await request(app).patch(PATH).send({ yearOfStudy: 3 })).status).toBe(401);
  });

  it("pending and deactivated accounts are denied before the handler runs", async () => {
    const { app, as, service } = build();
    expect((await request(app).get(PATH).set(as("pending"))).status).toBe(401);
    expect((await request(app).get(PATH).set(as("deactivated"))).status).toBe(401);
    expect((await request(app).patch(PATH).set(as("pending")).send({ yearOfStudy: 3 })).status).toBe(401);
    expect(service.get).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("non-student role (admin) gets 403", async () => {
    const { app, as, service } = build();
    expect((await request(app).get(PATH).set(as("adm"))).status).toBe(403);
    expect(service.get).not.toHaveBeenCalled();
  });

  it("GET returns the profile with Cache-Control: no-store", async () => {
    const { app, as, service } = build();
    const res = await request(app).get(PATH).set(as("stu"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.registration.name).toBe("Student One");
    expect(res.body.isComplete).toBe(true);
    expect(service.get).toHaveBeenCalledWith(expect.objectContaining({ userId: "stu" }));
  });

  it("PATCH with valid body returns the updated view with Cache-Control: no-store", async () => {
    const { app, as, service } = build();
    const res = await request(app).patch(PATH).set(as("stu")).send({ yearOfStudy: 4 });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.yearOfStudy).toBe(4);
    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "stu" }),
      expect.objectContaining({ yearOfStudy: 4 }),
    );
  });

  it("PATCH rejects unknown keys, registration fields and isComplete", async () => {
    const { app, as, service } = build();
    const invalid = [
      { registrationNumber: "CIT-221-001/2024" },
      { registrationStatus: "CONFIRMED" },
      { isComplete: true },
      { userId: "u1" },
      { name: "Hacker" },
      { status: "ACTIVE" },
    ];
    for (const body of invalid) {
      expect((await request(app).patch(PATH).set(as("stu")).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(service.update).not.toHaveBeenCalled();
  });

  it("PATCH rejects an empty object (no fields provided)", async () => {
    const { app, as } = build();
    expect((await request(app).patch(PATH).set(as("stu")).send({})).status).toBe(400);
  });

  it("PATCH with an invalid phone number returns 400", async () => {
    const { app, as } = build();
    expect((await request(app).patch(PATH).set(as("stu")).send({ phone: "12345" })).status).toBe(400);
  });
});
