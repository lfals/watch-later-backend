ALTER TABLE "catalog_metadata_cache" ADD COLUMN "metadata_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_metadata_cache" ALTER COLUMN "metadata_version" SET DEFAULT 2;
