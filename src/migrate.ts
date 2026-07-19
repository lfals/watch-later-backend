import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { logError, logEvent } from "./logger.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });

try {
  const startedAt = performance.now();
  logEvent("migration.started", { migrationsFolder: "drizzle" });
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  logEvent("migration.completed", { durationMs: Math.round(performance.now() - startedAt) });
} catch (error) {
  logError("migration.failed", error);
  throw error;
} finally {
  await pool.end();
}
