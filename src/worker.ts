import "dotenv/config";
import { Worker } from "bullmq";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { DrizzlePipelineStore } from "./pipeline-store.js";
import { CatalogWorkResolver, cleanupExpiredTemporaryEvidence, IdentificationPipeline, PublicInstagramScraper } from "./pipeline.js";
import { LocalIdentifier } from "./local-identifier.js";
import { logError, logEvent } from "./logger.js";
import { AniListCatalog, CompositeCatalog, TmdbCatalog } from "./catalog.js";
import { databaseLogSink } from "./admin.js";
import { configureLogSink } from "./logger.js";

const config = loadConfig();
if (!config.TMDB_API_TOKEN) throw new Error("TMDB_API_TOKEN is required to run the worker");
const db = drizzle(new Pool({ connectionString: config.DATABASE_URL }));
configureLogSink(databaseLogSink(db));
const catalog = new CompositeCatalog(new TmdbCatalog(config.TMDB_API_TOKEN), new AniListCatalog());
const scraper = config.SCRAPER_ENABLED === "true"
  ? new PublicInstagramScraper(
      100 * 1024 * 1024, 180, undefined,
      config.SCRAPER_BROWSER_FALLBACK === "true", config.SCRAPER_YTDLP_FALLBACK === "true",
    )
  : { scrape: async () => { throw new Error("scraper_disabled"); } };
const pipeline = new IdentificationPipeline(
  new DrizzlePipelineStore(db, config.IDENTIFICATION_PIPELINE_VERSION, config.IDENTIFICATION_CACHE_TTL_DAYS),
  scraper,
  new LocalIdentifier({
    baseUrl: config.OLLAMA_BASE_URL,
    model: config.OLLAMA_MODEL,
    requestTimeoutMs: config.LOCAL_MODEL_TIMEOUT_MS,
    tesseractCommand: config.TESSERACT_COMMAND,
    ocrLanguages: config.OCR_LANGUAGES,
    ocrTimeoutMs: config.OCR_TIMEOUT_MS,
    ocrConcurrency: config.OCR_CONCURRENCY,
    whisperCommand: config.WHISPER_COMMAND,
    whisperModelPath: config.WHISPER_MODEL_PATH,
  }),
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
