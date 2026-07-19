import "dotenv/config";
import { Worker } from "bullmq";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { DrizzlePipelineStore } from "./pipeline-store.js";
import { CatalogWorkResolver, cleanupExpiredTemporaryEvidence, GeminiIdentifier, IdentificationPipeline, PublicInstagramScraper } from "./pipeline.js";
import { combineLogSinks, logError, logEvent, logWarn, lokiLogSink, withLogContext } from "./logger.js";
import { AniListCatalog, CompositeCatalog, TmdbCatalog } from "./catalog.js";
import { databaseLogSink } from "./admin.js";
import { configureLogSink } from "./logger.js";
import { artifactStorageFromConfig } from "./artifact-storage.js";

const config = loadConfig();
const artifactStorage = artifactStorageFromConfig(config);
if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required to run the worker");
if (!config.TMDB_API_TOKEN) throw new Error("TMDB_API_TOKEN is required to run the worker");
const pool = new Pool({ connectionString: config.DATABASE_URL });
pool.on("error", (error) => logError("database.pool_error", error, { component: "worker" }));
const db = drizzle(pool);
configureLogSink(combineLogSinks(databaseLogSink(db), lokiLogSink({
  url: config.LOKI_URL,
  tenantId: config.LOKI_TENANT_ID,
  component: process.env.RAILWAY_SERVICE_NAME ?? "worker",
  environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV,
})));
const catalog = new CompositeCatalog(new TmdbCatalog(config.TMDB_API_TOKEN), new AniListCatalog());
const scraper = config.SCRAPER_ENABLED === "true"
  ? new PublicInstagramScraper(
      100 * 1024 * 1024, 180, undefined,
      config.SCRAPER_BROWSER_FALLBACK === "true", config.SCRAPER_YTDLP_FALLBACK === "true",
    )
  : { scrape: async () => { throw new Error("scraper_disabled"); } };
const pipeline = new IdentificationPipeline(
  new DrizzlePipelineStore(db, config.IDENTIFICATION_PIPELINE_VERSION, config.IDENTIFICATION_CACHE_TTL_DAYS, artifactStorage, config.TEMPORARY_MEDIA_RETENTION_DAYS),
  scraper,
  new GeminiIdentifier(config.GEMINI_API_KEY, config.GEMINI_MODEL),
  new CatalogWorkResolver(catalog),
);
const temporaryMediaRetentionMs = config.TEMPORARY_MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const sweepTemporaryEvidence = async () => {
  try {
    const removedDirectories = await cleanupExpiredTemporaryEvidence(undefined, temporaryMediaRetentionMs);
    logEvent("temporary_evidence.swept", { removedDirectories, retentionDays: config.TEMPORARY_MEDIA_RETENTION_DAYS });
  } catch (error) {
    logError("temporary_evidence.sweep_failed", error, { retentionDays: config.TEMPORARY_MEDIA_RETENTION_DAYS });
  }
};
await sweepTemporaryEvidence();
setInterval(sweepTemporaryEvidence, 60 * 60 * 1_000).unref();
const redis = new URL(config.REDIS_URL);
logEvent("worker.starting", {
  queue: "identify-reel", concurrency: 2, scraperEnabled: config.SCRAPER_ENABLED === "true",
  browserFallbackEnabled: config.SCRAPER_BROWSER_FALLBACK === "true", ytDlpFallbackEnabled: config.SCRAPER_YTDLP_FALLBACK === "true",
  lokiEnabled: Boolean(config.LOKI_URL), artifactStorageEnabled: Boolean(artifactStorage), railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
});
const worker = new Worker("identify-reel", (job) => withLogContext({
  jobId: job.id ?? null, submissionId: job.data.submissionId as string, attemptNumber: job.attemptsMade + 1,
}, async () => {
  const startedAt = performance.now();
  logEvent("worker.job_started", { queue: "identify-reel" });
  try {
    await pipeline.run(job.data.submissionId as string);
    logEvent("worker.job_processed", { durationMs: Math.round(performance.now() - startedAt) });
  } catch (error) {
    logError("worker.job_processing_failed", error, { durationMs: Math.round(performance.now() - startedAt) });
    throw error;
  }
}), {
  connection: { host: redis.hostname, port: Number(redis.port || 6379), password: redis.password || undefined }, concurrency: 2,
});
worker.on("ready", () => logEvent("worker.ready", { queue: "identify-reel", concurrency: 2 }));
worker.on("completed", (job) => logEvent("worker.job_completed", { jobId: job.id ?? null, attemptsMade: job.attemptsMade }));
worker.on("failed", (job, error) => logError("worker.job_failed", error, { jobId: job?.id ?? null, attemptsMade: job?.attemptsMade ?? 0 }));
worker.on("stalled", (jobId) => logWarn("worker.job_stalled", { jobId }));
worker.on("error", (error) => logError("worker.error", error));
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = performance.now();
  logEvent("worker.shutdown_started", { signal });
  try {
    await worker.close();
    await pool.end();
    logEvent("worker.shutdown_completed", { signal, durationMs: Math.round(performance.now() - startedAt) });
    process.exitCode = 0;
  } catch (error) {
    logError("worker.shutdown_failed", error, { signal });
    process.exitCode = 1;
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
