import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadConfig } from "./config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });

try {
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  console.log("Database migrations completed");
} finally {
  await pool.end();
}
