import type { RequestHandler } from "express";
import type { UserRoleName } from "@prisma/client";
import { Errors } from "../../shared/errors";
import { hasAnyRole } from "./actor-context";
import type { ActorContextService } from "./actor-context.service";
import type { TokenService } from "./token";

/**
 * Authentication (#50/#51): token -> user id -> ActorContext from CURRENT database state.
 * Establishes WHO is acting and nothing more. It makes no authorization decisions.
 */
export function createAuthenticate(deps: { tokens: TokenService; actors: ActorContextService }): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header) throw Errors.unauthenticated();

    const [scheme, token, ...rest] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) throw Errors.unauthenticated();

    const { userId } = deps.tokens.verify(token);
    req.actor = await deps.actors.load(userId);
    next();
  };
}

/**
 * Coarse, declarative role guard (#50): "does the actor hold ANY of these roles?" -> 403 if not.
 * This is only the cheap early reject. Relationship and workflow-state authorization
 * ("is this THEIR attachment, in an eligible state?") lives in application-service policies,
 * because the worker bypasses middleware entirely.
 */
export function requireRole(...roles: UserRoleName[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) throw Errors.unauthenticated();
    if (!hasAnyRole(req.actor, roles)) throw Errors.forbidden();
    next();
  };
}
