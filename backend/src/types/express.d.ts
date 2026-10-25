import type { Logger } from "pino";
import type { ActorContext } from "../modules/auth/actor-context";

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request; echoed in X-Request-Id and in every error body (#55). */
      requestId: string;
      /** Request-scoped logger carrying requestId. */
      log: Logger;
      /** Set by the authenticate middleware. Absent on unauthenticated routes. */
      actor?: ActorContext;
    }
  }
}
export {};
