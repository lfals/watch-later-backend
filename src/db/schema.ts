import { boolean, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid, index } from "drizzle-orm/pg-core";

export const workType = pgEnum("work_type", ["movie", "series", "anime"]);
export const watchStatus = pgEnum("watch_status", ["want_to_watch", "watching", "watched"]);
export const submissionStatus = pgEnum("submission_status", ["queued", "waiting_for_quota", "scraping", "identifying", "needs_confirmation", "identified", "failed"]);
export const catalogProvider = pgEnum("catalog_provider", ["tmdb", "anilist", "imdb", "yts"]);
export const userRole = pgEnum("user_role", ["user", "viewer", "admin"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  role: userRole("role").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const quotaSettings = pgTable("quota_settings", {
  id: text("id").primaryKey().default("global"),
  dailyNovelLimit: integer("daily_novel_limit").notNull().default(10),
  dailyRetryLimit: integer("daily_retry_limit").notNull().default(3),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userQuotaOverrides = pgTable("user_quota_overrides", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  dailyNovelLimit: integer("daily_novel_limit"),
  dailyRetryLimit: integer("daily_retry_limit"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dailyQuotaUsage = pgTable("daily_quota_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  windowDate: text("window_date").notNull(),
  novelCount: integer("novel_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("daily_quota_usage_user_window_unique").on(table.userId, table.windowDate)]);

export const dailyRetryUsage = pgTable("daily_retry_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  normalizedUrlHash: text("normalized_url_hash").notNull(),
  windowDate: text("window_date").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("daily_retry_usage_user_url_window_unique").on(table.userId, table.normalizedUrlHash, table.windowDate)]);

export const operationalLogs = pgTable("operational_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  level: text("level").notNull(),
  service: text("service").notNull(),
  event: text("event").notNull(),
  submissionId: uuid("submission_id"),
  fields: jsonb("fields").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("operational_logs_created_at_idx").on(table.createdAt),
  index("operational_logs_event_idx").on(table.event),
  index("operational_logs_submission_idx").on(table.submissionId),
]);

export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorClerkUserId: text("actor_clerk_user_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  fields: jsonb("fields").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("admin_audit_logs_created_at_idx").on(table.createdAt),
  index("admin_audit_logs_target_idx").on(table.targetType, table.targetId),
]);

export const works = pgTable("works", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: workType("type").notNull(),
  title: text("title").notNull(),
  originalTitle: text("original_title"),
  releaseYear: text("release_year"),
  synopsis: text("synopsis"),
  posterUrl: text("poster_url"),
  tmdbId: text("tmdb_id"),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  isCustom: boolean("is_custom").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("works_tmdb_id_unique").on(table.tmdbId)]);

export const externalWorkIds = pgTable("external_work_ids", {
  id: uuid("id").primaryKey().defaultRandom(),
  workId: uuid("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  provider: catalogProvider("provider").notNull(),
  externalId: text("external_id").notNull(),
}, (table) => [uniqueIndex("external_work_ids_provider_id_unique").on(table.provider, table.externalId)]);

export const catalogMetadataCache = pgTable("catalog_metadata_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: catalogProvider("provider").notNull(),
  externalId: text("external_id").notNull(),
  type: workType("type").notNull(),
  actors: jsonb("actors").$type<Array<{ name: string; role: string | null; profileUrl: string | null }>>().notNull().default([]),
  directors: jsonb("directors").$type<Array<{ name: string; role: string | null; profileUrl: string | null }>>().notNull().default([]),
  rating: real("rating"),
  genres: jsonb("genres").$type<string[]>().notNull().default([]),
  trailerUrl: text("trailer_url"),
  synopsis: text("synopsis"),
  seasons: jsonb("seasons").$type<Array<{
    seasonNumber: number;
    name: string;
    overview: string | null;
    airDate: string | null;
    episodeCount: number;
    posterUrl: string | null;
    episodes: Array<{
      episodeNumber: number;
      name: string;
      overview: string | null;
      airDate: string | null;
      runtimeMinutes: number | null;
    }>;
  }>>().notNull().default([]),
  metadataVersion: integer("metadata_version").notNull().default(5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("catalog_metadata_cache_work_unique").on(table.provider, table.externalId, table.type)]);

export const watchlistEntries = pgTable("watchlist_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workId: uuid("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  status: watchStatus("status").notNull().default("want_to_watch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("watchlist_user_work_unique").on(table.userId, table.workId)]);

export const stremioConnections = pgTable("stremio_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("stremio_connections_user_unique").on(table.userId),
  uniqueIndex("stremio_connections_token_hash_unique").on(table.tokenHash),
]);

export const reelSubmissions = pgTable("reel_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workId: uuid("work_id").references(() => works.id, { onDelete: "set null" }),
  originalUrl: text("original_url").notNull(),
  normalizedUrl: text("normalized_url").notNull(),
  normalizedUrlHash: text("normalized_url_hash").notNull(),
  status: submissionStatus("status").notNull().default("queued"),
  identifiedTitle: text("identified_title"),
  confidence: text("confidence"),
  failureCode: text("failure_code"),
  candidates: jsonb("candidates").$type<Array<{
    provider: "tmdb" | "anilist"; externalId: string; type: "movie" | "series" | "anime";
    title: string; originalTitle: string | null; releaseYear: string | null; synopsis: string | null; posterUrl: string | null;
  }>>().notNull().default([]),
  resolutionSource: text("resolution_source"),
  contentFingerprint: text("content_fingerprint"),
  quotaCharged: boolean("quota_charged").notNull().default(false),
  quotaWindowDate: text("quota_window_date"),
  evidenceSummary: jsonb("evidence_summary").$type<{
    metadata?: { title: string | null; description: string | null };
    media?: { present: boolean; sizeBytes: number; mimeType?: string };
    artifacts?: Array<{ kind: "frame" | "audio"; mimeType: string; sizeBytes: number }>;
    identification?: { rationale: string; corroborated: boolean; transcriptEvidence: string | null; onScreenText: string[] };
  }>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("reel_submissions_user_url_unique").on(table.userId, table.normalizedUrlHash)]);

export const submissionArtifacts = pgTable("submission_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id").notNull().references(() => reelSubmissions.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"frame" | "audio" | "video">().notNull(),
  mimeType: text("mime_type").notNull(), sizeBytes: text("size_bytes").notNull(),
  dataBase64: text("data_base64"),
  objectKey: text("object_key"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("submission_artifacts_submission_idx").on(table.submissionId), index("submission_artifacts_expires_idx").on(table.expiresAt)]);

export const identificationCache = pgTable("identification_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  normalizedUrlHash: text("normalized_url_hash").notNull(),
  pipelineVersion: text("pipeline_version").notNull(),
  status: submissionStatus("status").notNull(),
  workId: uuid("work_id").references(() => works.id, { onDelete: "cascade" }),
  identifiedTitle: text("identified_title"),
  confidence: text("confidence"),
  candidates: jsonb("candidates").$type<Array<{
    provider: "tmdb" | "anilist"; externalId: string; type: "movie" | "series" | "anime";
    title: string; originalTitle: string | null; releaseYear: string | null; synopsis: string | null; posterUrl: string | null;
  }>>().notNull().default([]),
  contentFingerprint: text("content_fingerprint"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("identification_cache_url_version_unique").on(table.normalizedUrlHash, table.pipelineVersion),
  index("identification_cache_fingerprint_version_idx").on(table.contentFingerprint, table.pipelineVersion),
  index("identification_cache_expires_at_idx").on(table.expiresAt),
]);
