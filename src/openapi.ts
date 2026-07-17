import { z, type OpenAPIHono } from "@hono/zod-openapi";

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const errorSchema = z.object({
  error: z.string().openapi({ example: "invalid_pagination" }),
}).openapi("ApiError");

const errors = {
  unauthorized: json(errorSchema, "Missing or invalid authentication token"),
  notFound: json(errorSchema, "Resource not found"),
  conflict: json(errorSchema, "The resource state does not allow this operation"),
  validation: json(errorSchema, "Invalid request"),
  rateLimited: json(errorSchema, "Daily submission or retry quota exceeded"),
  internal: json(errorSchema, "Unexpected server error"),
};

const workTypeSchema = z.enum(["movie", "series"]);
const watchStatusSchema = z.enum(["want_to_watch", "watching", "watched"]);
const submissionStatusSchema = z.enum([
  "queued", "waiting_for_quota", "scraping", "identifying",
  "needs_confirmation", "identified", "failed",
]);

const movieSchema = z.object({
  externalId: z.string().openapi({ example: "550" }),
  title: z.string().openapi({ example: "Fight Club" }),
  originalTitle: z.string().nullable().openapi({ example: "Fight Club" }),
  releaseYear: z.string().nullable().openapi({ example: "1999" }),
  synopsis: z.string().nullable(),
  posterUrl: z.url().nullable(),
}).openapi("Movie");

const catalogWorkSchema = movieSchema.extend({
  provider: z.literal("tmdb"),
  type: workTypeSchema,
}).openapi("CatalogWork");

const workSchema = z.object({
  id: z.uuid().optional(),
  externalId: z.string(),
  provider: z.enum(["tmdb", "custom"]),
  type: workTypeSchema,
  title: z.string(),
  originalTitle: z.string().nullable().optional(),
  releaseYear: z.string().nullable().optional(),
  synopsis: z.string().nullable().optional(),
  posterUrl: z.url().nullable().optional(),
  isCustom: z.boolean().optional(),
}).passthrough().openapi("Work");

const watchlistEntrySchema = z.object({
  entryId: z.uuid(),
  status: watchStatusSchema,
  workId: z.uuid(),
  type: workTypeSchema,
  title: z.string(),
  originalTitle: z.string().nullable(),
  releaseYear: z.string().nullable(),
  synopsis: z.string().nullable(),
  posterUrl: z.url().nullable(),
  externalId: z.string().nullable(),
  provider: z.enum(["tmdb"]).nullable(),
  createdAt: z.iso.datetime().optional(),
}).passthrough().openapi("WatchlistEntry");

const candidateSchema = catalogWorkSchema.openapi("SubmissionCandidate");
const submissionSchema = z.object({
  id: z.uuid(),
  normalizedUrl: z.url(),
  status: submissionStatusSchema,
  identifiedTitle: z.string().nullable().optional(),
  confidence: z.string().nullable().optional(),
  failureCode: z.string().nullable().optional(),
  candidates: z.array(candidateSchema).optional(),
  resolutionSource: z.string().nullable().optional(),
  workId: z.uuid().nullable().optional(),
  work: workSchema.nullable().optional(),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
}).passthrough().openapi("Submission");

const paginationQuery = z.object({
  before: z.iso.datetime().optional().openapi({ description: "Exclusive ISO 8601 cursor returned by the previous page" }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const entryParams = z.object({ entryId: z.uuid() });
const submissionParams = z.object({ submissionId: z.uuid() });
const security = [{ Bearer: [] }];

export function registerPublicOpenApi(app: OpenAPIHono<any>) {
  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Clerk session token",
  });

  app.openAPIRegistry.registerPath({
    method: "get", path: "/health", tags: ["System"], summary: "Check API health",
    responses: { 200: json(z.object({ status: z.literal("ok") }), "API is available") },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/catalog/movies", tags: ["Catalog"], summary: "Search movies",
    description: "Legacy movie-only TMDB search endpoint.", security,
    request: { query: z.object({ q: z.string().min(2).openapi({ description: "Movie title" }) }) },
    responses: { 200: json(z.object({ items: z.array(movieSchema) }), "Matching movies"), 401: errors.unauthorized, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/catalog/works", tags: ["Catalog"], summary: "Search movies or series", security,
    request: { query: z.object({ q: z.string().min(2), type: workTypeSchema }) },
    responses: { 200: json(z.object({ items: z.array(catalogWorkSchema) }), "Matching catalog works"), 401: errors.unauthorized, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/catalog/streaming", tags: ["Catalog"], summary: "Find streaming availability in Brazil", security,
    request: { query: z.object({ provider: z.enum(["tmdb", "anilist"]), externalId: z.string().min(1), type: z.enum(["movie", "series", "anime"]), title: z.string().min(1) }) },
    responses: { 200: json(z.object({ region: z.literal("BR"), checkedAt: z.iso.datetime(), providers: z.array(z.object({ name: z.string(), logoUrl: z.url().nullable(), url: z.url() })) }), "Streaming providers"), 401: errors.unauthorized, 422: errors.validation, 500: errors.internal },
  });

  app.openAPIRegistry.registerPath({
    method: "post", path: "/v1/watchlist/movies", tags: ["Watchlist"], summary: "Add a movie to the watchlist", security,
    request: { body: { required: true, content: { "application/json": { schema: movieSchema } } } },
    responses: { 201: json(z.object({ item: watchlistEntrySchema }), "Movie saved"), 401: errors.unauthorized, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "post", path: "/v1/watchlist/works", tags: ["Watchlist"], summary: "Add a catalog work to the watchlist", security,
    request: { body: { required: true, content: { "application/json": { schema: catalogWorkSchema } } } },
    responses: { 201: json(z.object({ item: watchlistEntrySchema }), "Work saved"), 401: errors.unauthorized, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/watchlist", tags: ["Watchlist"], summary: "List watchlist entries", security,
    request: { query: paginationQuery },
    responses: { 200: json(z.object({ items: z.array(watchlistEntrySchema), nextCursor: z.iso.datetime().nullable() }), "Paginated watchlist"), 401: errors.unauthorized, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/watchlist/{entryId}", tags: ["Watchlist"], summary: "Get a watchlist entry", security,
    request: { params: entryParams },
    responses: { 200: json(z.object({ item: watchlistEntrySchema.extend({ sources: z.array(z.object({ id: z.uuid(), normalizedUrl: z.url(), createdAt: z.iso.datetime(), resolutionSource: z.string().nullable() })) }) }), "Watchlist entry and source Reels"), 401: errors.unauthorized, 404: errors.notFound, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "patch", path: "/v1/watchlist/{entryId}", tags: ["Watchlist"], summary: "Update watch status", security,
    request: { params: entryParams, body: { required: true, content: { "application/json": { schema: z.object({ status: watchStatusSchema }) } } } },
    responses: { 200: json(z.object({ item: z.object({ id: z.uuid(), status: watchStatusSchema }).passthrough() }), "Status updated"), 401: errors.unauthorized, 404: errors.notFound, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "delete", path: "/v1/watchlist/{entryId}", tags: ["Watchlist"], summary: "Remove a watchlist entry", security,
    request: { params: entryParams },
    responses: { 204: { description: "Entry removed" }, 401: errors.unauthorized, 404: errors.notFound, 500: errors.internal },
  });

  app.openAPIRegistry.registerPath({
    method: "post", path: "/v1/submissions", tags: ["Submissions"], summary: "Submit an Instagram Reel for identification", security,
    request: { body: { required: true, content: { "application/json": { schema: z.object({ url: z.string().openapi({ example: "https://www.instagram.com/reel/ABC123/" }) }) } } } },
    responses: { 202: json(z.object({ item: submissionSchema }), "Submission persisted and accepted for processing"), 401: errors.unauthorized, 422: errors.validation, 429: errors.rateLimited, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/submissions/{submissionId}", tags: ["Submissions"], summary: "Get submission details", security,
    request: { params: submissionParams },
    responses: { 200: json(z.object({ item: submissionSchema }), "Submission details, candidates, and result"), 401: errors.unauthorized, 404: errors.notFound, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "post", path: "/v1/submissions/{submissionId}/confirm", tags: ["Submissions"], summary: "Confirm an identification candidate", security,
    request: { params: submissionParams, body: { required: true, content: { "application/json": { schema: catalogWorkSchema } } } },
    responses: { 200: json(z.object({ item: workSchema }), "Candidate confirmed and added to the watchlist"), 401: errors.unauthorized, 404: errors.notFound, 409: errors.conflict, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "post", path: "/v1/submissions/{submissionId}/resolve", tags: ["Submissions"], summary: "Resolve a submission manually", security,
    request: { params: submissionParams, body: { required: true, content: { "application/json": { schema: z.discriminatedUnion("mode", [z.object({ mode: z.literal("catalog"), work: catalogWorkSchema }), z.object({ mode: z.literal("custom"), title: z.string().min(1).max(200), type: workTypeSchema, releaseYear: z.string().regex(/^\d{4}$/).nullable().optional(), synopsis: z.string().max(5000).nullable().optional() })]) } } } },
    responses: { 200: json(z.object({ item: workSchema }), "Submission resolved and added to the watchlist"), 401: errors.unauthorized, 404: errors.notFound, 409: errors.conflict, 422: errors.validation, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "post", path: "/v1/submissions/{submissionId}/reprocess", tags: ["Submissions"], summary: "Request submission reprocessing", security,
    request: { params: submissionParams },
    responses: { 202: json(z.object({ item: submissionSchema }), "Submission queued again"), 401: errors.unauthorized, 404: errors.notFound, 409: errors.conflict, 429: errors.rateLimited, 500: errors.internal },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/inbox", tags: ["Submissions"], summary: "List unresolved submissions", security,
    request: { query: paginationQuery },
    responses: { 200: json(z.object({ items: z.array(submissionSchema), nextCursor: z.iso.datetime().nullable() }), "Paginated submission inbox"), 401: errors.unauthorized, 422: errors.validation, 500: errors.internal },
  });
}
