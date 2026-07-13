import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  CLERK_JWT_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_AUTHORIZED_PARTIES: z.string().default(""),
  TMDB_API_TOKEN: z.string().optional(),
  ALLOW_DEV_AUTH: z.enum(["true", "false"]).default("false"),
  ADMIN_CLERK_USER_IDS: z.string().default(""),
  ADMIN_ORIGINS: z.string().default("http://localhost:5173"),
  SCRAPER_ENABLED: z.enum(["true", "false"]).default("true"),
  SCRAPER_BROWSER_FALLBACK: z.enum(["true", "false"]).default("true"),
  SCRAPER_YTDLP_FALLBACK: z.enum(["true", "false"]).default("true"),
  IDENTIFICATION_PIPELINE_VERSION: z.string().min(1).default("v1"),
  IDENTIFICATION_CACHE_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  TEMPORARY_MEDIA_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
