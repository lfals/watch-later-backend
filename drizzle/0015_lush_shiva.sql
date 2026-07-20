ALTER TABLE "catalog_metadata_cache" ALTER COLUMN "metadata_version" SET DEFAULT 3;--> statement-breakpoint
ALTER TABLE "catalog_metadata_cache" ADD COLUMN "trailer_url" text;