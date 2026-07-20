import { describe, expect, it } from "vitest";
import { mobileErrorSchema, sanitizeMobileDiagnostic } from "../src/mobile-error.js";

describe("mobile error ingestion", () => {
  it("redacts URLs, email addresses, bearer credentials, and JWTs", () => {
    const value = sanitizeMobileDiagnostic(
      "GET https://api.example.com/users/1 user@example.com Bearer secret eyJhbGciOiJIUzI1NiJ9.payload.signature",
      1_000,
    );
    expect(value).toBe("GET [redacted_url] [redacted_email] Bearer [redacted] [redacted_token]");
  });

  it("accepts only bounded structured error fields", () => {
    expect(mobileErrorSchema.safeParse({
      event: "api.request_failed", errorType: "DioException", errorCode: "http_500", platform: "android",
      appVersion: "1.0.0", buildNumber: "1", releaseMode: true, occurredAt: "2026-07-20T12:00:00.000Z",
      clientErrorId: "error-1", httpMethod: "GET", requestPath: "/v1/inbox", httpStatus: 500,
    }).success).toBe(true);
    expect(mobileErrorSchema.safeParse({ event: "contains spaces" }).success).toBe(false);
  });
});
