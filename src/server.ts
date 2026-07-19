import "dotenv/config";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { AniListCatalog, CompositeCatalog, TmdbCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { WatchlistRepository } from "./repository.js";
import { BullSubmissionQueue } from "./queue.js";
import { AdminStore, databaseLogSink } from "./admin.js";
import { combineLogSinks, configureLogSink, lokiLogSink, logError, logEvent } from "./logger.js";
import { QuotaService } from "./quota.js";
import { startQuotaReconciler } from "./quota-reconciler.js";
import { artifactStorageFromConfig } from "./artifact-storage.js";

const config = loadConfig();
const artifactStorage = artifactStorageFromConfig(config);
const pool = new Pool({ connectionString: config.DATABASE_URL });
pool.on("error", (error) => logError("database.pool_error", error, { component: "api" }));
const db = drizzle(pool);
configureLogSink(combineLogSinks(databaseLogSink(db), lokiLogSink({
  url: config.LOKI_URL,
  tenantId: config.LOKI_TENANT_ID,
  component: process.env.RAILWAY_SERVICE_NAME ?? "api",
  environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV,
})));
const tmdb = config.TMDB_API_TOKEN
  ? new TmdbCatalog(config.TMDB_API_TOKEN)
  : {
      searchMovies: async () => { throw new Error("TMDB_API_TOKEN is not configured"); },
      search: async () => { throw new Error("TMDB_API_TOKEN is not configured"); },
      streaming: async () => { throw new Error("TMDB_API_TOKEN is not configured"); },
    };
const catalog = new CompositeCatalog(tmdb, new AniListCatalog());
const queue = new BullSubmissionQueue(config.REDIS_URL);
const app = createApp({
  config, catalog, repository: new WatchlistRepository(db, config.IDENTIFICATION_PIPELINE_VERSION, config.IDENTIFICATION_CACHE_TTL_DAYS), queue,
  admin: new AdminStore(db, new Set(config.ADMIN_CLERK_USER_IDS.split(",").map((item) => item.trim()).filter(Boolean)), artifactStorage),
});
startQuotaReconciler(new QuotaService(db), queue);
logEvent("api.starting", {
  port: config.PORT, lokiEnabled: Boolean(config.LOKI_URL), artifactStorageEnabled: Boolean(artifactStorage),
  railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
});
const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => logEvent("api.ready", { port }));
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = performance.now();
  logEvent("api.shutdown_started", { signal });
  server.close();
  try {
    await queue.close();
    await pool.end();
    logEvent("api.shutdown_completed", { signal, durationMs: Math.round(performance.now() - startedAt) });
    process.exitCode = 0;
  } catch (error) {
    logError("api.shutdown_failed", error, { signal });
    process.exitCode = 1;
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
