import { parse, serialize } from "cookie";
import type { Request, Response } from "express";
import type { CookieConfig } from "./session.config";

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  return header ? parse(header)[name] : undefined;
}

const attrs = (cfg: CookieConfig) => ({
  httpOnly: true, // never readable by page scripts (Decision #51)
  secure: cfg.secure,
  sameSite: cfg.sameSite,
  path: cfg.path,
});

export function setRefreshCookie(res: Response, cfg: CookieConfig, value: string, maxAgeSeconds: number): void {
  res.append("Set-Cookie", serialize(cfg.name, value, { ...attrs(cfg), maxAge: maxAgeSeconds }));
}

export function clearRefreshCookie(res: Response, cfg: CookieConfig): void {
  res.append("Set-Cookie", serialize(cfg.name, "", { ...attrs(cfg), maxAge: 0, expires: new Date(0) }));
}
