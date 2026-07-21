import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authorizedPartiesForToken } from "../src/auth.js";
import type { CatalogWork } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";

const movie: CatalogWork = { provider: "tmdb", type: "movie", externalId: "550", title: "Fight Club", originalTitle: "Fight Club", releaseYear: "1999", synopsis: "Test", posterUrl: null };
const config = { PORT: 3000, DATABASE_URL: "test", REDIS_URL: "redis://localhost:6379", GEMINI_MODEL: "gemini-3.5-flash", CLERK_AUTHORIZED_PARTIES: "", ALLOW_DEV_AUTH: "true" as const, ADMIN_CLERK_USER_IDS: "", ADMIN_ORIGINS: "http://localhost:5173", SCRAPER_ENABLED: "true" as const, SCRAPER_BROWSER_FALLBACK: "true" as const, SCRAPER_YTDLP_FALLBACK: "true" as const, IDENTIFICATION_PIPELINE_VERSION: "v1", IDENTIFICATION_CACHE_TTL_DAYS: 180, TEMPORARY_MEDIA_RETENTION_DAYS: 7 };
const unsignedToken = (payload: Record<string, unknown>) => [
  Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url"),
  Buffer.from(JSON.stringify(payload)).toString("base64url"),
  Buffer.from("signature").toString("base64url"),
].join(".");

describe("manual watchlist slice", () => {
  it("requires an authorized Clerk party outside development auth", () => {
    expect(() => loadConfig({ DATABASE_URL: "test", ALLOW_DEV_AUTH: "false", CLERK_AUTHORIZED_PARTIES: "" })).toThrow();
    expect(loadConfig({ DATABASE_URL: "test" }).CLERK_AUTHORIZED_PARTIES)
      .toContain("chrome-extension://flhdhfkcdekjplgdjojflifnioleggok");
  });

  it("supports native Clerk tokens while preserving browser authorized-party checks", () => {
    const parties = "https://watchlater.felps.zip,chrome-extension://example";

    expect(authorizedPartiesForToken(unsignedToken({ sub: "native-user" }), parties)).toBeUndefined();
    expect(authorizedPartiesForToken(unsignedToken({ sub: "web-user", azp: "https://watchlater.felps.zip" }), parties))
      .toEqual(["https://watchlater.felps.zip", "chrome-extension://example"]);
  });

  it("allows the production admin origin by default", async () => {
    const productionConfig = loadConfig({ DATABASE_URL: "test" });
    const app = createApp({ config: productionConfig, catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) }, repository: { addMovie: async () => ({}), list: async () => [], createSubmission: async () => ({}), inbox: async () => [], addWork: async () => ({}) } });

    const response = await app.request("/v1/admin/logs", {
      method: "OPTIONS",
      headers: {
        Origin: "https://watchlater.felps.zip",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://watchlater.felps.zip");
  });

  it("publishes Swagger UI and documents every non-administrative endpoint", async () => {
    const app = createApp({ config, catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) }, repository: { addMovie: async () => ({}), list: async () => [], createSubmission: async () => ({}), inbox: async () => [], addWork: async () => ({}) } });
    const docs = await app.request("/docs");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("SwaggerUIBundle");

    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const contract = await response.json() as { paths: Record<string, unknown>; components?: { securitySchemes?: Record<string, unknown> } };
    expect(Object.keys(contract.paths)).toEqual(expect.arrayContaining([
      "/health", "/v1/catalog/movies", "/v1/catalog/works", "/v1/catalog/streaming",
      "/v1/client-errors",
      "/v1/watchlist/movies", "/v1/watchlist/works", "/v1/watchlist", "/v1/watchlist/{entryId}",
      "/v1/submissions", "/v1/submissions/{submissionId}", "/v1/submissions/{submissionId}/confirm",
      "/v1/submissions/{submissionId}/resolve", "/v1/submissions/{submissionId}/reprocess", "/v1/inbox",
    ]));
    expect(Object.keys(contract.paths).some((path) => path.startsWith("/v1/admin"))).toBe(false);
    expect(contract.components?.securitySchemes).toHaveProperty("Bearer");
    const submissionResponse = (contract.paths["/v1/submissions"] as {
      post: { responses: { "202": { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } } };
    }).post.responses["202"].content["application/json"].schema;
    expect(submissionResponse.properties.outcome).toEqual({
      type: "string",
      enum: ["accepted", "already_exists", "cache_hit", "waiting_for_quota"],
    });
  });

  it("searches and saves a movie for an authenticated development user", async () => {
    const saved: unknown[] = [];
    const app = createApp({ config, catalog: { searchMovies: async () => [movie], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: new Date().toISOString(), providers: [] }) }, repository: {
      addMovie: async (_user, value) => (saved.push(value), value), list: async () => saved,
      createSubmission: async (_user, reel) => reel, inbox: async () => [], addWork: async () => ({}),
    }});
    const headers = { "x-dev-user-id": "user_test", "content-type": "application/json" };
    const search = await app.request("/v1/catalog/movies?q=fight", { headers });
    expect(search.status).toBe(200);
    const add = await app.request("/v1/watchlist/movies", { method: "POST", headers, body: JSON.stringify(movie) });
    expect(add.status).toBe(201);
    const list = await app.request("/v1/watchlist", { headers });
    expect((await list.json()).items).toHaveLength(1);
  });

  it("rejects an unauthenticated request", async () => {
    const app = createApp({ config: { ...config, ALLOW_DEV_AUTH: "false" }, catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) }, repository: { addMovie: async () => ({}), list: async () => [], createSubmission: async () => ({}), inbox: async () => [], addWork: async () => ({}) } });
    expect((await app.request("/v1/watchlist")).status).toBe(401);
  });

  it("returns the correlation id on every request", async () => {
    const app = createApp({ config, catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) }, repository: { addMovie: async () => ({}), list: async () => [], createSubmission: async () => ({}), inbox: async () => [], addWork: async () => ({}) } });
    const generated = await app.request("/docs");
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const propagated = await app.request("/docs", { headers: { "x-request-id": "client-correlation-1" } });
    expect(propagated.headers.get("x-request-id")).toBe("client-correlation-1");
  });

  it("accepts only authenticated structured mobile errors", async () => {
    const app = createApp({ config, catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) }, repository: { addMovie: async () => ({}), list: async () => [], createSubmission: async () => ({}), inbox: async () => [], addWork: async () => ({}) } });
    const payload = {
      event: "api.request_failed", errorType: "DioException", errorCode: "http_500", platform: "android",
      appVersion: "1.0.0", buildNumber: "1", releaseMode: true, occurredAt: "2026-07-20T12:00:00.000Z",
      clientErrorId: "error-1", httpMethod: "GET", requestPath: "/v1/inbox", httpStatus: 500,
    };
    expect((await app.request("/v1/client-errors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).status).toBe(401);
    expect((await app.request("/v1/client-errors", { method: "POST", headers: { "content-type": "application/json", "x-dev-user-id": "mobile-user" }, body: JSON.stringify(payload) })).status).toBe(202);
    expect((await app.request("/v1/client-errors", { method: "POST", headers: { "content-type": "application/json", "x-dev-user-id": "mobile-user" }, body: JSON.stringify({ ...payload, event: "invalid event" }) })).status).toBe(422);
  });

  it("normalizes a shared Reel and rejects unsupported links", async () => {
    const app = createApp({ config, catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) }, repository: {
      addMovie: async () => ({}), list: async () => [], inbox: async () => [], createSubmission: async (_user, reel) => ({ ...reel, outcome: "accepted" as const }), addWork: async () => ({}),
    }});
    const headers = { "x-dev-user-id": "user_test", "content-type": "application/json" };
    const accepted = await app.request("/v1/submissions", { method: "POST", headers, body: JSON.stringify({ url: "Veja https://www.instagram.com/reel/ABC123/?igsh=x" }) });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      outcome: "accepted",
      item: { normalizedUrl: "https://www.instagram.com/reel/ABC123/" },
    });
    const rejected = await app.request("/v1/submissions", { method: "POST", headers, body: JSON.stringify({ url: "https://youtube.com/shorts/x" }) });
    expect(rejected.status).toBe(422);
  });

  it.each([
    ["accepted", { cacheHit: false, shouldEnqueue: true }, 1],
    ["already_exists", { cacheHit: false, shouldEnqueue: false }, 0],
    ["cache_hit", { cacheHit: true, shouldEnqueue: false }, 0],
    ["waiting_for_quota", { cacheHit: false, shouldEnqueue: false }, 0],
  ] as const)("returns the %s submission outcome without changing item", async (outcome, flags, expectedEnqueues) => {
    const enqueued: string[] = [];
    const app = createApp({
      config,
      catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) },
      repository: {
        addMovie: async () => ({}), list: async () => [], inbox: async () => [], addWork: async () => ({}),
        createSubmission: async (_user, reel) => ({ id: "submission-1", ...reel, normalizedUrlHash: "hash-1", outcome, ...flags }),
      },
      queue: { enqueue: async (id) => { enqueued.push(id); } },
    });

    const response = await app.request("/v1/submissions", {
      method: "POST",
      headers: { "x-dev-user-id": "user_test", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.instagram.com/reel/OUTCOME123/" }),
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ outcome, item: { id: "submission-1", ...flags } });
    expect(body.item).not.toHaveProperty("outcome");
    expect(enqueued).toHaveLength(expectedEnqueues);
  });

  it("keeps anime outside the MVP public catalog contract", async () => {
    const app = createApp({ config, catalog: {
      searchMovies: async () => [], search: async () => [],
      streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }),
    }, repository: {
      addMovie: async () => ({}), list: async () => [], inbox: async () => [],
      createSubmission: async () => ({}), addWork: async () => ({}),
    }});
    const headers = { "x-dev-user-id": "user_test", "content-type": "application/json" };
    expect((await app.request("/v1/catalog/works?q=bebop&type=anime", { headers })).status).toBe(422);
    expect((await app.request("/v1/watchlist/works", {
      method: "POST", headers, body: JSON.stringify({ ...movie, provider: "anilist", type: "anime" }),
    })).status).toBe(422);
  });

  it("protects operational logs with backend-owned admin roles", async () => {
    const repository = {
      addMovie: async () => ({}), list: async () => [], inbox: async () => [],
      createSubmission: async () => ({}), addWork: async () => ({}),
    };
    const catalog = {
      searchMovies: async () => [], search: async () => [],
      streaming: async () => ({ region: "BR" as const, checkedAt: "", providers: [] }),
    };
    const adminDefaults = { health: async () => ({} as never), audits: async () => [], audit: async () => ({} as never), prepareReprocess: async () => ({ id: "sub" }), cache: async () => [], invalidateCache: async (id: string) => ({ id }), submission: async (id: string) => ({ id, timeline: [], evidenceSummary: {} } as never), artifact: async () => ({} as never), quotas: async () => ({} as never), updateGlobalQuotas: async () => ({} as never), updateUserQuotas: async () => ({} as never) };
    const denied = createApp({ config, catalog, repository, admin: { ...adminDefaults, role: async () => "user", logs: async () => [], submissions: async () => [] } });
    expect((await denied.request("/v1/admin/logs", { headers: { "x-dev-user-id": "regular" } })).status).toBe(403);

    const allowed = createApp({ config, catalog, repository, admin: { ...adminDefaults,
      role: async () => "viewer",
      logs: async () => [{ id: "log-1", level: "info", service: "watch-later-backend", event: "worker.ready", submissionId: null, fields: {}, createdAt: new Date("2026-07-12T12:00:00Z") }],
      submissions: async () => [],
    } });
    const response = await allowed.request("/v1/admin/logs", { headers: { "x-dev-user-id": "reviewer" } });
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].event).toBe("worker.ready");
    const detail = await allowed.request("/v1/admin/submissions/sub-1", { headers: { "x-dev-user-id": "reviewer" } });
    expect(detail.status).toBe(200);
    expect((await detail.json()).item.id).toBe("sub-1");
  });

  it("exposes confirmation, watch status, deletion, and reprocessing commands", async () => {
    const calls: string[] = [];
    const app = createApp({ config, catalog: {
      searchMovies: async () => [], search: async () => [],
      streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }),
    }, repository: {
      addMovie: async () => ({}), addWork: async () => ({}), list: async () => [], inbox: async () => [],
      createSubmission: async () => ({}),
      confirmSubmission: async () => (calls.push("confirm"), { title: "Fight Club" }),
      updateStatus: async (_user, _entry, status) => (calls.push(status), { status }),
      remove: async () => (calls.push("remove"), {}),
      prepareReprocess: async (_user, id) => (calls.push("reprocess"), { id }),
    }});
    const headers = { "x-dev-user-id": "user_test", "content-type": "application/json" };
    expect((await app.request("/v1/submissions/sub-1/confirm", { method: "POST", headers, body: JSON.stringify(movie) })).status).toBe(200);
    expect((await app.request("/v1/watchlist/entry-1", { method: "PATCH", headers, body: JSON.stringify({ status: "watched" }) })).status).toBe(200);
    expect((await app.request("/v1/watchlist/entry-1", { method: "DELETE", headers })).status).toBe(204);
    expect((await app.request("/v1/submissions/sub-1/reprocess", { method: "POST", headers })).status).toBe(202);
    expect(calls).toEqual(["confirm", "watched", "remove", "reprocess"]);
  });

  it("serves a personal Stremio catalog and requires confirmation before marking a movie watched", async () => {
    const token = "a".repeat(43);
    const marked: string[] = [];
    const catalogRequests: Array<{ type: string; status: string; skip?: number }> = [];
    const stremio = {
      connect: async (_user: string, baseUrl: string) => ({ installUrl: `${baseUrl}/stremio/${token}/manifest.json`, connectedAt: "2026-07-21T12:00:00.000Z" }),
      status: async () => ({ connected: true, connectedAt: "2026-07-21T12:00:00.000Z" }),
      disconnect: async () => true,
      isAuthorized: async (candidate: string) => candidate === token,
      catalog: async (_token: string, type: "movie" | "series", status: "want_to_watch" | "watching" | "watched", skip?: number) => {
        catalogRequests.push({ type, status, skip });
        return type === "series"
          ? [{ id: "tt0944947", type: "series" as const, name: "Game of Thrones", releaseInfo: "2011" }]
          : [{ id: "tt0137523", type: "movie" as const, name: "Fight Club", releaseInfo: "1999" }];
      },
      action: async (_token: string, imdbId: string) => ["tt0137523", "tt0944947"].includes(imdbId) ? ({ entryId: "entry-1", imdbId, title: imdbId === "tt0944947" ? "Game of Thrones" : "Fight Club", status: "want_to_watch" as const }) : null,
      markWatched: async (_token: string, imdbId: string) => {
        marked.push(imdbId);
        return { entryId: "entry-1", imdbId, title: "Fight Club", status: "watched" as const };
      },
    };
    const app = createApp({ config, stremio, catalog: {
      searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }),
    }, repository: {
      addMovie: async () => ({}), addWork: async () => ({}), list: async () => [], inbox: async () => [], createSubmission: async () => ({}),
    }});
    const auth = { "x-dev-user-id": "stremio-user" };

    const connection = await app.request("/v1/integrations/stremio", { method: "POST", headers: auth });
    expect(connection.status).toBe(201);
    expect(await connection.json()).toMatchObject({ installUrl: `http://localhost/stremio/${token}/manifest.json` });

    const manifest = await app.request(`/stremio/${token}/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("access-control-allow-origin")).toBe("*");
    const manifestBody = await manifest.json() as { types: string[]; resources: unknown[]; catalogs: Array<{ type: string; id: string }> };
    expect(manifestBody.resources).toContain("catalog");
    expect(manifestBody.types).toEqual(["movie", "series"]);
    expect(manifestBody.catalogs).toContainEqual(expect.objectContaining({ type: "series", id: "watchlater-series-want-to-watch" }));
    expect((await app.request(`/stremio/${"b".repeat(43)}/manifest.json`)).status).toBe(404);

    const catalog = await app.request(`/stremio/${token}/catalog/movie/watchlater-want-to-watch/skip=100.json`);
    expect(await catalog.json()).toEqual({ metas: [{ id: "tt0137523", type: "movie", name: "Fight Club", releaseInfo: "1999" }] });
    const seriesCatalog = await app.request(`/stremio/${token}/catalog/series/watchlater-series-want-to-watch.json`);
    expect(await seriesCatalog.json()).toEqual({ metas: [{ id: "tt0944947", type: "series", name: "Game of Thrones", releaseInfo: "2011" }] });
    expect(catalogRequests).toEqual([
      { type: "movie", status: "want_to_watch", skip: 100 },
      { type: "series", status: "want_to_watch", skip: 0 },
    ]);

    const streams = await app.request(`/stremio/${token}/stream/movie/tt0137523.json`);
    expect(await streams.json()).toEqual({ streams: [{
      name: "Watchlater",
      description: "Marcar como visto no Watchlater",
      externalUrl: `http://localhost/stremio/${token}/action/watched/tt0137523`,
    }] });
    const seriesStreams = await app.request(`/stremio/${token}/stream/series/tt0944947:1:1.json`);
    expect(await seriesStreams.json()).toEqual({ streams: [{
      name: "Watchlater",
      description: "Marcar como visto no Watchlater",
      externalUrl: `http://localhost/stremio/${token}/action/watched/tt0944947`,
    }] });
    const confirmation = await app.request(`/stremio/${token}/action/watched/tt0137523`);
    expect(confirmation.status).toBe(200);
    expect(await confirmation.text()).toContain("Marcar como visto");
    expect(marked).toEqual([]);

    const completed = await app.request(`/stremio/${token}/action/watched/tt0137523`, { method: "POST" });
    expect(completed.status).toBe(200);
    expect(await completed.text()).toContain("Marcado como visto");
    expect(marked).toEqual(["tt0137523"]);
  });
});
