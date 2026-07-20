ALTER TABLE "catalog_metadata_cache" ALTER COLUMN "metadata_version" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "catalog_metadata_cache" ADD COLUMN "synopsis" text;