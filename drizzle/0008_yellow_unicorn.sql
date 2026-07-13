CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_clerk_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identification_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"status" "submission_status" NOT NULL,
	"work_id" uuid,
	"identified_title" text,
	"confidence" text,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_fingerprint" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD COLUMN "content_fingerprint" text;--> statement-breakpoint
ALTER TABLE "identification_cache" ADD CONSTRAINT "identification_cache_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_target_idx" ON "admin_audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identification_cache_url_version_unique" ON "identification_cache" USING btree ("normalized_url_hash","pipeline_version");--> statement-breakpoint
CREATE INDEX "identification_cache_fingerprint_version_idx" ON "identification_cache" USING btree ("content_fingerprint","pipeline_version");--> statement-breakpoint
CREATE INDEX "identification_cache_expires_at_idx" ON "identification_cache" USING btree ("expires_at");