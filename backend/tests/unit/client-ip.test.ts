import { describe, expect, it } from "vitest";
import { clientIp } from "../../src/shared/client-ip";

describe("clientIp", () => {
  it("prefers req.ip, then the socket address, then a constant", () => {
    expect(clientIp({ ip: "203.0.113.7", socket: { remoteAddress: "10.0.0.1" } } as never)).toBe("203.0.113.7");
    expect(clientIp({ ip: undefined, socket: { remoteAddress: "10.0.0.1" } } as never)).toBe("10.0.0.1");
    expect(clientIp({ ip: undefined, socket: {} } as never)).toBe("unknown");
  });
});
