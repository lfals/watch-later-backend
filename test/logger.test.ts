import { describe, expect, it, vi } from "vitest";
import { lokiLogSink } from "../src/logger.js";

describe("Loki log sink", () => {
  it("pushes structured logs with useful stream labels", async () => {
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      request = init;
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const sink = lokiLogSink({
      url: "http://loki:3100/loki/api/v1/push",
      component: "worker",
      environment: "test",
      fetch,
    });

    await sink!({
      timestamp: new Date("2026-07-16T12:00:00.000Z"),
      level: "error",
      service: "watch-later-backend",
      event: "worker.job_failed",
      fields: { jobId: "job-1", attemptsMade: 2 },
    });

    const body = JSON.parse(String(request?.body));
    expect(body.streams[0].stream).toEqual({
      service: "watch-later-backend", component: "worker", environment: "test", level: "error",
    });
    expect(JSON.parse(body.streams[0].values[0][1])).toMatchObject({ event: "worker.job_failed", jobId: "job-1" });
  });
});
