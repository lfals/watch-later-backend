import "dotenv/config";
import { Worker } from "bullmq";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { DrizzlePipelineStore } from "./pipeline-store.js";
import { CatalogWorkResolver, cleanupExpiredTemporaryEvidence, GeminiIdentifier, IdentificationPipeline, PublicInstagramScraper } from "./pipeline.js";
import { combineLogSinks, logError, logEvent, lokiLogSink } from "./logger.js";
import { AniListCatalog, CompositeCatalog, TmdbCatalog } from "./catalog.js";
import { databaseLogSink } from "./admin.js";
import { configureLogSink } from "./logger.js";
import { artifactStorageFromConfig } from "./artifact-storage.js";

const config = loadConfig();
const artifactStorage = artifactStorageFromConfig(config);
if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required to run the worker");
if (!config.TMDB_API_TOKEN) throw new Error("TMDB_API_TOKEN is required to run the worker");
const db = drizzle(new Pool({ connectionString: config.DATABASE_URL }));
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
const worker = new Worker("identify-reel", (job) => pipeline.run(job.data.submissionId as string), {
  connection: { host: redis.hostname, port: Number(redis.port || 6379), password: redis.password || undefined }, concurrency: 2,
});
worker.on("ready", () => logEvent("worker.ready", { queue: "identify-reel", concurrency: 2 }));
worker.on("completed", (job) => logEvent("worker.job_completed", { jobId: job.id ?? null, attemptsMade: job.attemptsMade }));
worker.on("failed", (job, error) => logError("worker.job_failed", error, { jobId: job?.id ?? null, attemptsMade: job?.attemptsMade ?? 0 }));
worker.on("error", (error) => logError("worker.error", error));
