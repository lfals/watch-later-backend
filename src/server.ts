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
import { configureLogSink } from "./logger.js";
import { QuotaService } from "./quota.js";
import { startQuotaReconciler } from "./quota-reconciler.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const db = drizzle(pool);
configureLogSink(databaseLogSink(db));
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
  admin: new AdminStore(db, new Set(config.ADMIN_CLERK_USER_IDS.split(",").map((item) => item.trim()).filter(Boolean))),
});
startQuotaReconciler(new QuotaService(db), queue);
serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => console.log(`Watch Later API listening on :${port}`));
