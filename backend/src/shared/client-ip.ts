import type { Request } from "express";

/** The one place a request's client address is read. Express resolves it using the trust-proxy setting. */
export const clientIp = (req: Pick<Request, "ip" | "socket">): string =>
  req.ip ?? req.socket?.remoteAddress ?? "unknown";
