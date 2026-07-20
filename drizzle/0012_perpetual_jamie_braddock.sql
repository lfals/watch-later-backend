CREATE TABLE "catalog_metadata_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "catalog_provider" NOT NULL,
	"external_id" text NOT NULL,
	"type" "work_type" NOT NULL,
	"actors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rating" real,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_metadata_cache_work_unique" ON "catalog_metadata_cache" USING btree ("provider","external_id","type");