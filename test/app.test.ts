import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { CatalogWork } from "../src/catalog.js";

const movie: CatalogWork = { provider: "tmdb", type: "movie", externalId: "550", title: "Fight Club", originalTitle: "Fight Club", releaseYear: "1999", synopsis: "Test", posterUrl: null };
const config = { PORT: 3000, DATABASE_URL: "test", REDIS_URL: "redis://localhost:6379", OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "gemma3:4b", LOCAL_MODEL_TIMEOUT_MS: 120_000, TESSERACT_COMMAND: "tesseract", OCR_LANGUAGES: "eng", OCR_TIMEOUT_MS: 5_000, OCR_CONCURRENCY: 2, WHISPER_COMMAND: "whisper-cli", CLERK_AUTHORIZED_PARTIES: "", ALLOW_DEV_AUTH: "true" as const, ADMIN_CLERK_USER_IDS: "", ADMIN_ORIGINS: "http://localhost:5173", SCRAPER_ENABLED: "true" as const, SCRAPER_BROWSER_FALLBACK: "true" as const, SCRAPER_YTDLP_FALLBACK: "true" as const, IDENTIFICATION_PIPELINE_VERSION: "local-v1", IDENTIFICATION_CACHE_TTL_DAYS: 180, TEMPORARY_MEDIA_RETENTION_DAYS: 7 };

describe("manual watchlist slice", () => {
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

  it("normalizes a shared Reel and rejects unsupported links", async () => {
    const app = createApp({ config, catalog: { searchMovies: async () => [], search: async () => [], streaming: async () => ({ region: "BR", checkedAt: "", providers: [] }) }, repository: {
      addMovie: async () => ({}), list: async () => [], inbox: async () => [], createSubmission: async (_user, reel) => reel, addWork: async () => ({}),
    }});
    const headers = { "x-dev-user-id": "user_test", "content-type": "application/json" };
    const accepted = await app.request("/v1/submissions", { method: "POST", headers, body: JSON.stringify({ url: "Veja https://www.instagram.com/reel/ABC123/?igsh=x" }) });
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).item.normalizedUrl).toBe("https://www.instagram.com/reel/ABC123/");
    const rejected = await app.request("/v1/submissions", { method: "POST", headers, body: JSON.stringify({ url: "https://youtube.com/shorts/x" }) });
    expect(rejected.status).toBe(422);
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
});
