import { verifyToken } from "@clerk/backend";
import { decodeJwt } from "@clerk/backend/jwt";
import type { MiddlewareHandler } from "hono";
import type { Config } from "./config.js";
import { logWarn } from "./logger.js";

export type AuthVariables = { clerkUserId: string };

export function authorizedPartiesForToken(token: string, configuredParties: string): string[] | undefined {
  const { azp } = decodeJwt(token).payload;
  if (!azp) return undefined;

  return configuredParties.split(",").map((party) => party.trim()).filter(Boolean);
}

export function authMiddleware(config: Config): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (context, next) => {
    const devUser = context.req.header("x-dev-user-id");
    if (config.ALLOW_DEV_AUTH === "true" && devUser) {
      context.set("clerkUserId", devUser);
      return next();
    }

    const authorization = context.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token) {
      logWarn("auth.rejected", { reason: "missing_bearer_token" });
      return context.json({ error: "unauthorized" }, 401);
    }

    try {
      const payload = await verifyToken(token, {
        jwtKey: config.CLERK_JWT_KEY,
        secretKey: config.CLERK_SECRET_KEY,
        // Native Clerk sessions do not include `azp`. Browser sessions that do
        // include it must still match the configured origin allowlist.
        authorizedParties: authorizedPartiesForToken(token, config.CLERK_AUTHORIZED_PARTIES),
      });
      context.set("clerkUserId", payload.sub);
      return next();
    } catch {
      logWarn("auth.rejected", { reason: "invalid_bearer_token" });
      return context.json({ error: "unauthorized" }, 401);
    }
  };
}
