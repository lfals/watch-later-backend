import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Catalog, CatalogMovie } from "./catalog.js";
import type { Config } from "./config.js";
import { authMiddleware, type AuthVariables } from "./auth.js";
import { normalizeInstagramReel } from "./reels.js";
import type { SubmissionQueue } from "./queue.js";
import type { CatalogWork } from "./catalog.js";
import { logError, logEvent, logWarn, withLogContext } from "./logger.js";
import type { AdminStore } from "./admin.js";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import { registerPublicOpenApi } from "./openapi.js";
import { randomUUID } from "node:crypto";
import { mobileErrorSchema, recordMobileError } from "./mobile-error.js";

type Repository = {
  addMovie(userId: string, movie: CatalogMovie): Promise<unknown>;
  list(userId: string, page?: { before?: Date; limit?: number }): Promise<unknown[]>;
  createSubmission(userId: string, reel: ReturnType<typeof normalizeInstagramReel>): Promise<unknown>;
  inbox(userId: string, page?: { before?: Date; limit?: number }): Promise<unknown[]>;
  addWork(userId: string, work: CatalogWork): Promise<unknown>;
  confirmSubmission?(userId: string, submissionId: string, work: CatalogWork, manual?: boolean): Promise<unknown>;
  createCustomResolution?(userId: string, submissionId: string, input: { title: string; type: "movie" | "series"; releaseYear?: string | null; synopsis?: string | null }): Promise<unknown>;
  prepareReprocess?(userId: string, submissionId: string): Promise<unknown>;
  updateStatus?(userId: string, entryId: string, status: "want_to_watch" | "watching" | "watched"): Promise<unknown>;
  remove?(userId: string, entryId: string): Promise<unknown>;
  detail?(userId: string, entryId: string): Promise<unknown>;
  submissionDetail?(userId: string, submissionId: string): Promise<unknown>;
};

const movieSchema = z.object({ externalId: z.string(), title: z.string(), originalTitle: z.string().nullable(), releaseYear: z.string().nullable(), synopsis: z.string().nullable(), posterUrl: z.string().nullable() });
const catalogWorkSchema = movieSchema.extend({ provider: z.literal("tmdb"), type: z.enum(["movie", "series"]) });

export function createApp(deps: { config: Config; catalog: Catalog; repository: Repository; queue?: SubmissionQueue; admin?: Pick<AdminStore, "role" | "logs" | "submissions" | "submission" | "artifact" | "health" | "audit" | "audits" | "prepareReprocess" | "cache" | "invalidateCache" | "quotas" | "updateGlobalQuotas" | "updateUserQuotas"> }) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  const mobileErrorWindows = new Map<string, { startedAt: number; count: number }>();
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.slice(0, 100) || randomUUID();
    c.header("x-request-id", requestId);
    const path = c.req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
    const routineProbe = path === "/health";
    const startedAt = performance.now();
    return withLogContext({ requestId }, async () => {
      if (!routineProbe) logEvent("http.request_started", { method: c.req.method, path });
      await next();
      const fields = { method: c.req.method, path, status: c.res.status, durationMs: Math.round(performance.now() - startedAt) };
      if (!routineProbe || c.res.status >= 400) {
        if (c.res.status >= 400) logWarn("http.request_completed", fields);
        else logEvent("http.request_completed", fields);
      }
    });
  });
  app.use("/v1/admin/*", cors({
    origin: deps.config.ADMIN_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
    allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], maxAge: 600,
  }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/docs", swaggerUI({ url: "/openapi.json", persistAuthorization: true }));
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Watch Later API",
      version: "1.0.0",
      description: "Public client API for catalog search, watchlist management, and Instagram Reel identification. Administrative endpoints are intentionally excluded.",
    },
    tags: [
      { name: "System", description: "Service availability" },
      { name: "Catalog", description: "Movie and series discovery" },
      { name: "Watchlist", description: "The authenticated user's saved works" },
      { name: "Submissions", description: "Instagram Reel identification workflow" },
    ],
  });
  app.use("/v1/*", authMiddleware(deps.config));
  app.post("/v1/client-errors", async (c) => {
    const parsed = mobileErrorSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_client_error" }, 422);
    const userId = c.get("clerkUserId");
    const now = Date.now();
    const current = mobileErrorWindows.get(userId);
    const window = !current || now - current.startedAt >= 60_000 ? { startedAt: now, count: 0 } : current;
    if (window.count >= 30) return c.json({ error: "client_error_rate_limited" }, 429);
    window.count += 1;
    mobileErrorWindows.set(userId, window);
    recordMobileError(parsed.data);
    return c.json({ accepted: true }, 202);
  });
  app.use("/v1/admin/*", async (c, next) => {
    if (!deps.admin) return c.json({ error: "admin_unavailable" }, 503);
    const role = await deps.admin.role(c.get("clerkUserId"));
    if (!["viewer", "admin"].includes(role)) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  app.get("/v1/admin/logs", async (c) => {
    const parsed = z.object({
      level: z.enum(["info", "warn", "error"]).optional(), event: z.string().max(120).optional(),
      submissionId: z.string().uuid().optional(), before: z.iso.datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_log_query" }, 422);
    const items = await deps.admin!.logs({ ...parsed.data, before: parsed.data.before ? new Date(parsed.data.before) : undefined });
    return c.json({ items, nextCursor: items.at(-1)?.createdAt.toISOString() ?? null });
  });

  app.get("/v1/admin/submissions", async (c) => {
    const parsed = z.object({ status: z.enum(["queued", "waiting_for_quota", "scraping", "identifying", "needs_confirmation", "identified", "failed"]).optional() }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_submission_query" }, 422);
    return c.json({ items: await deps.admin!.submissions(parsed.data.status) });
  });
  app.get("/v1/admin/submissions/:submissionId", async (c) => c.json({ item: await deps.admin!.submission(c.req.param("submissionId")) }));
  app.get("/v1/admin/artifacts/:artifactId", async (c) => {
    const artifact = await deps.admin!.artifact(c.req.param("artifactId"));
    return new Response(new Uint8Array(artifact.data), { headers: { "Content-Type": artifact.mimeType, "Content-Length": String(artifact.data.length), "Cache-Control": "private, max-age=300" } });
  });
  app.get("/v1/admin/cache", async (c) => c.json({ items: await deps.admin!.cache() }));
  app.delete("/v1/admin/cache/:cacheId", async (c) => {
    if (await deps.admin!.role(c.get("clerkUserId")) !== "admin") return c.json({ error: "forbidden" }, 403);
    const item = await deps.admin!.invalidateCache(c.req.param("cacheId"));
    await deps.admin!.audit(c.get("clerkUserId"), { action: "cache.invalidate", targetType: "identification_cache", targetId: item.id, reason: "manual_invalidation" });
    logEvent("identification_cache.invalidated", { cacheId: item.id });
    return c.json({ item });
  });
  app.get("/v1/admin/quotas", async (c) => c.json(await deps.admin!.quotas()));
  app.put("/v1/admin/quotas/global", async (c) => {
    if (await deps.admin!.role(c.get("clerkUserId")) !== "admin") return c.json({ error: "forbidden" }, 403);
    const parsed = z.object({ dailyNovelLimit: z.number().int().min(1).max(10_000), dailyRetryLimit: z.number().int().min(0).max(100) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid_quota_settings" }, 422);
    const item = await deps.admin!.updateGlobalQuotas(parsed.data);
    await deps.admin!.audit(c.get("clerkUserId"), { action: "quota.global.update", targetType: "quota_settings", targetId: "global", reason: "admin_configuration" });
    return c.json({ item });
  });
  app.put("/v1/admin/quotas/users/:clerkUserId", async (c) => {
    if (await deps.admin!.role(c.get("clerkUserId")) !== "admin") return c.json({ error: "forbidden" }, 403);
    const parsed = z.object({ dailyNovelLimit: z.number().int().min(1).max(10_000).nullable(), dailyRetryLimit: z.number().int().min(0).max(100).nullable() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid_quota_settings" }, 422);
    const item = await deps.admin!.updateUserQuotas(c.req.param("clerkUserId"), parsed.data);
    await deps.admin!.audit(c.get("clerkUserId"), { action: "quota.user.update", targetType: "user", targetId: c.req.param("clerkUserId"), reason: "admin_configuration" });
    return c.json({ item });
  });

  app.get("/v1/admin/health", async (c) => c.json(await deps.admin!.health()));
  app.get("/v1/admin/audits", async (c) => c.json({ items: await deps.admin!.audits() }));
  app.post("/v1/admin/submissions/:submissionId/reprocess", async (c) => {
    if (await deps.admin!.role(c.get("clerkUserId")) !== "admin") return c.json({ error: "admin_required" }, 403);
    const parsed = z.object({ reason: z.string().trim().min(10).max(500) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "reason_required" }, 422);
    const item = await deps.admin!.prepareReprocess(c.req.param("submissionId"));
    await deps.queue?.enqueue(item.id, `admin-${item.id}-${Date.now()}`);
    await deps.admin!.audit(c.get("clerkUserId"), { action: "submission.reprocess", targetType: "submission", targetId: item.id, reason: parsed.data.reason });
    logEvent("admin.submission_reprocessed", { submissionId: item.id });
    return c.json({ item }, 202);
  });

  app.openapi(createRoute({ method: "get", path: "/v1/catalog/movies", request: { query: z.object({ q: z.string().min(2) }) }, responses: { 200: { description: "Movie results", content: { "application/json": { schema: z.object({ items: z.array(movieSchema) }) } } } } }), async (c) => {
    const { q } = c.req.valid("query");
    return c.json({ items: await deps.catalog.searchMovies(q) }, 200);
  });

  app.openapi(createRoute({ method: "post", path: "/v1/watchlist/movies", request: { body: { content: { "application/json": { schema: movieSchema } } } }, responses: { 201: { description: "Saved" } } }), async (c) => {
    const item = await deps.repository.addMovie(c.get("clerkUserId"), c.req.valid("json"));
    return c.json({ item }, 201);
  });

  app.get("/v1/watchlist", async (c) => {
    const parsed = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_pagination" }, 422);
    const items = await deps.repository.list(c.get("clerkUserId"), { before: parsed.data.before ? new Date(parsed.data.before) : undefined, limit: parsed.data.limit }) as Array<{ createdAt?: Date }>;
    return c.json({ items, nextCursor: items.length === parsed.data.limit ? items.at(-1)?.createdAt?.toISOString() ?? null : null });
  });
  app.get("/v1/watchlist/:entryId", async (c) => c.json({ item: await deps.repository.detail!(c.get("clerkUserId"), c.req.param("entryId")) }));
  app.patch("/v1/watchlist/:entryId", async (c) => {
    const parsed = z.object({ status: z.enum(["want_to_watch", "watching", "watched"]) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid_watch_status" }, 422);
    return c.json({ item: await deps.repository.updateStatus!(c.get("clerkUserId"), c.req.param("entryId"), parsed.data.status) });
  });
  app.delete("/v1/watchlist/:entryId", async (c) => {
    await deps.repository.remove!(c.get("clerkUserId"), c.req.param("entryId"));
    return c.body(null, 204);
  });
  app.get("/v1/catalog/works", async (c) => {
    const query = c.req.query("q") ?? "";
    const type = c.req.query("type") as "movie" | "series";
    if (query.length < 2 || !["movie", "series"].includes(type)) return c.json({ error: "invalid_search" }, 422);
    return c.json({ items: await deps.catalog.search(query, type) });
  });
  app.get("/v1/catalog/streaming", async (c) => {
    const parsed = z.object({
      provider: z.enum(["tmdb", "anilist"]), externalId: z.string().min(1),
      type: z.enum(["movie", "series", "anime"]), title: z.string().min(1),
    }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_work" }, 422);
    return c.json(await deps.catalog.streaming(parsed.data));
  });
  app.post("/v1/watchlist/works", async (c) => {
    const parsed = catalogWorkSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid_work" }, 422);
    return c.json({ item: await deps.repository.addWork(c.get("clerkUserId"), parsed.data) }, 201);
  });
  app.post("/v1/submissions", async (c) => {
    const body = await c.req.json<{ url?: string }>();
    try {
      const item = await deps.repository.createSubmission(c.get("clerkUserId"), normalizeInstagramReel(body.url ?? "")) as { id: string; normalizedUrlHash: string; cacheHit?: boolean; shouldEnqueue?: boolean };
      logEvent("submission.persisted", { submissionId: item.id, hasSharedText: Boolean(body.url), sharedTextLength: body.url?.length ?? 0 });
      if (item.shouldEnqueue !== false && !item.cacheHit) await deps.queue?.enqueue(item.id, item.normalizedUrlHash);
      logEvent("submission.accepted", { submissionId: item.id });
      return c.json({ item }, 202);
    } catch (error) {
      if (error instanceof Error && ["invalid_reel_url", "unsupported_url"].includes(error.message)) {
        logEvent("submission.rejected", { reason: error.message, hasSharedText: Boolean(body.url), sharedTextLength: body.url?.length ?? 0 });
        return c.json({ error: error.message }, 422);
      }
      logError("submission.failed", error);
      throw error;
    }
  });
  app.post("/v1/submissions/:submissionId/confirm", async (c) => {
    const parsed = catalogWorkSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid_candidate" }, 422);
    const item = await deps.repository.confirmSubmission!(c.get("clerkUserId"), c.req.param("submissionId"), parsed.data);
    logEvent("submission.confirmed", { submissionId: c.req.param("submissionId"), provider: parsed.data.provider });
    return c.json({ item });
  });
  app.get("/v1/submissions/:submissionId", async (c) =>
    c.json({ item: await deps.repository.submissionDetail!(c.get("clerkUserId"), c.req.param("submissionId")) }));
  app.post("/v1/submissions/:submissionId/resolve", async (c) => {
    const body = await c.req.json();
    const catalogResolution = z.object({ mode: z.literal("catalog"), work: catalogWorkSchema }).safeParse(body);
    if (catalogResolution.success) {
      const item = await deps.repository.confirmSubmission!(c.get("clerkUserId"), c.req.param("submissionId"), catalogResolution.data.work, true);
      logEvent("submission.resolved_manually", { submissionId: c.req.param("submissionId"), mode: "catalog" });
      return c.json({ item });
    }
    const customResolution = z.object({
      mode: z.literal("custom"), title: z.string().trim().min(1).max(200), type: z.enum(["movie", "series"]),
      releaseYear: z.string().regex(/^\d{4}$/).nullable().optional(), synopsis: z.string().max(5000).nullable().optional(),
    }).safeParse(body);
    if (!customResolution.success) return c.json({ error: "invalid_manual_resolution" }, 422);
    const item = await deps.repository.createCustomResolution!(c.get("clerkUserId"), c.req.param("submissionId"), customResolution.data);
    logEvent("submission.resolved_manually", { submissionId: c.req.param("submissionId"), mode: "custom" });
    return c.json({ item });
  });
  app.post("/v1/submissions/:submissionId/reprocess", async (c) => {
    const item = await deps.repository.prepareReprocess!(c.get("clerkUserId"), c.req.param("submissionId")) as { id: string; normalizedUrlHash: string };
    await deps.queue?.enqueue(item.id, item.normalizedUrlHash);
    logEvent("submission.reprocess_requested", { submissionId: item.id });
    return c.json({ item }, 202);
  });
  app.get("/v1/inbox", async (c) => {
    const parsed = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_pagination" }, 422);
    const items = await deps.repository.inbox(c.get("clerkUserId"), { before: parsed.data.before ? new Date(parsed.data.before) : undefined, limit: parsed.data.limit }) as Array<{ createdAt?: Date }>;
    return c.json({ items, nextCursor: items.length === parsed.data.limit ? items.at(-1)?.createdAt?.toISOString() ?? null : null });
  });
  app.onError((error, c) => {
    const code = error instanceof Error ? error.message : "internal_error";
    const notFound = ["submission_not_found", "watchlist_entry_not_found", "cache_entry_not_found"];
    const conflict = ["candidate_not_allowed", "submission_busy", "submission_already_resolved", "submission_not_retryable"];
    if (notFound.includes(code)) return c.json({ error: code }, 404);
    if (conflict.includes(code)) return c.json({ error: code }, 409);
    if (code === "retry_limit_exceeded") return c.json({ error: code }, 429);
    logError("request.failed", error, { path: c.req.path });
    return c.json({ error: "internal_error" }, 500);
  });
  registerPublicOpenApi(app);
  return app;
}
