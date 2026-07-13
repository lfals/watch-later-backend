CREATE TYPE "public"."submission_status" AS ENUM('queued', 'failed');--> statement-breakpoint
CREATE TABLE "reel_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"original_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"status" "submission_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD CONSTRAINT "reel_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reel_submissions_user_url_unique" ON "reel_submissions" USING btree ("user_id","normalized_url_hash");