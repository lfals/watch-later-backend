CREATE TYPE "public"."catalog_provider" AS ENUM('tmdb', 'anilist', 'imdb', 'yts');--> statement-breakpoint
CREATE TABLE "external_work_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"provider" "catalog_provider" NOT NULL,
	"external_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "tmdb_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "external_work_ids" ADD CONSTRAINT "external_work_ids_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_work_ids_provider_id_unique" ON "external_work_ids" USING btree ("provider","external_id");