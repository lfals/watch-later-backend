import { z } from "zod";
import { logError } from "./logger.js";

const identifier = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/);

export const mobileErrorSchema = z.object({
  event: identifier,
  errorType: identifier,
  errorCode: identifier.optional(),
  message: z.string().max(2_000).optional(),
  stackTrace: z.string().max(8_000).optional(),
  platform: z.enum(["android", "ios", "macos", "windows", "linux", "web", "unknown"]),
  appVersion: z.string().trim().min(1).max(40),
  buildNumber: z.string().trim().min(1).max(40),
  releaseMode: z.boolean(),
  occurredAt: z.iso.datetime(),
  clientErrorId: z.string().trim().min(1).max(100),
  httpMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  requestPath: z.string().trim().max(200).regex(/^\/[a-zA-Z0-9_./:-]*$/).optional(),
  httpStatus: z.number().int().min(0).max(599).optional(),
});

export type MobileErrorInput = z.infer<typeof mobileErrorSchema>;

export function sanitizeMobileDiagnostic(value: string | undefined, maxLength: number) {
  if (!value) return undefined;
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, "[redacted_token]")
    .replace(/https?:\/\/[^\s)\]}]+/gi, "[redacted_url]")
    .replace(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g, "[redacted_email]")
    .slice(0, maxLength);
}

export function recordMobileError(input: MobileErrorInput) {
  logError("mobile.error", new Error(input.errorCode ?? "mobile_unhandled_error"), {
    component: "mobile",
    mobileEvent: input.event,
    clientErrorType: input.errorType,
    diagnosticMessage: sanitizeMobileDiagnostic(input.message, 1_000),
    clientStackTrace: sanitizeMobileDiagnostic(input.stackTrace, 4_000),
    platform: input.platform,
    appVersion: input.appVersion,
    buildNumber: input.buildNumber,
    releaseMode: input.releaseMode,
    occurredAt: input.occurredAt,
    clientErrorId: input.clientErrorId,
    httpMethod: input.httpMethod,
    requestPath: input.requestPath,
    httpStatus: input.httpStatus,
  });
}
