import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { StudentRegistrationService } from "../../src/modules/student-registration/student-registration.service";
import { ORIGIN, buildTestApp } from "./helpers";

const PATH = "/api/v1/auth";

function build() {
  const ctx = buildTestApp();
  const service = {
    register: vi.fn(async () => ({
      message: "If these details can be used to create an account, a verification email is on its way. Check your inbox.",
    })),
    verifyEmail: vi.fn(async () => ({ emailVerified: true as const })),
  } as unknown as StudentRegistrationService;
  const app = createApp({
    logger: ctx.logger,
    corsOrigins: [ORIGIN],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    studentRegistration: service,
  });
  return { app, service };
}

const body = {
  name: "Jane Student",
  email: "Jane@Example.test",
  registrationNumber: "CIT-221-001/2024",
  password: "Correct-Horse-9!",
};

describe("student registration HTTP routes", () => {
  it("accepts registration and returns the generic acknowledgement without caching", async () => {
    const { app, service } = build();
    const response = await request(app).post(`${PATH}/register`).set("Origin", ORIGIN).send(body);

    expect(response.status).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      message: "If these details can be used to create an account, a verification email is on its way. Check your inbox.",
    });
    expect(service.register).toHaveBeenCalledWith(
      { ...body, email: "jane@example.test", registrationNumber: "CIT-221-001/2024" },
      { ip: expect.any(String) },
    );
  });

  it("rejects foreign/missing origins before parsing the registration body", async () => {
    const { app, service } = build();
    expect((await request(app).post(`${PATH}/register`).send({ invalid: true })).status).toBe(403);
    expect((await request(app).post(`${PATH}/register`).set("Origin", "https://foreign.example").send(body)).status).toBe(403);
    expect(service.register).not.toHaveBeenCalled();
  });

  it("validates registration and verification bodies", async () => {
    const { app, service } = build();
    const invalidRegistration = await request(app)
      .post(`${PATH}/register`)
      .set("Origin", ORIGIN)
      .send({ ...body, role: "ADMIN" });
    expect(invalidRegistration.status).toBe(400);
    expect(invalidRegistration.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.register).not.toHaveBeenCalled();

    const invalidVerification = await request(app)
      .post(`${PATH}/verify-email`)
      .set("Origin", ORIGIN)
      .send({ token: "", extra: true });
    expect(invalidVerification.status).toBe(400);
    expect(invalidVerification.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.verifyEmail).not.toHaveBeenCalled();
  });

  it("verifies with a no-store response", async () => {
    const { app, service } = build();
    const response = await request(app)
      .post(`${PATH}/verify-email`)
      .set("Origin", ORIGIN)
      .send({ token: "raw-one-time-token" });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ status: "email_verified" });
    expect(service.verifyEmail).toHaveBeenCalledWith(
      { token: "raw-one-time-token" },
      { ip: expect.any(String) },
    );
    expect(JSON.stringify(response.body)).not.toContain("raw-one-time-token");
  });
});
