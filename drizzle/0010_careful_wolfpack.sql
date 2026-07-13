ALTER TYPE "public"."submission_status" ADD VALUE 'waiting_for_quota' BEFORE 'scraping';--> statement-breakpoint
CREATE TABLE "daily_quota_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"window_date" text NOT NULL,
	"novel_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_retry_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"window_date" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"daily_novel_limit" integer DEFAULT 10 NOT NULL,
	"daily_retry_limit" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" text NOT NULL,
	"data_base64" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_quota_overrides" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"daily_novel_limit" integer,
	"daily_retry_limit" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD COLUMN "quota_charged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD COLUMN "quota_window_date" text;--> statement-breakpoint
ALTER TABLE "daily_quota_usage" ADD CONSTRAINT "daily_quota_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_retry_usage" ADD CONSTRAINT "daily_retry_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_artifacts" ADD CONSTRAINT "submission_artifacts_submission_id_reel_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."reel_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_quota_overrides" ADD CONSTRAINT "user_quota_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_quota_usage_user_window_unique" ON "daily_quota_usage" USING btree ("user_id","window_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_retry_usage_user_url_window_unique" ON "daily_retry_usage" USING btree ("user_id","normalized_url_hash","window_date");--> statement-breakpoint
CREATE INDEX "submission_artifacts_submission_idx" ON "submission_artifacts" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submission_artifacts_expires_idx" ON "submission_artifacts" USING btree ("expires_at");