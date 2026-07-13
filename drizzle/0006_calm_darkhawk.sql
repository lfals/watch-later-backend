CREATE TYPE "public"."user_role" AS ENUM('user', 'viewer', 'admin');--> statement-breakpoint
CREATE TABLE "operational_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" text NOT NULL,
	"service" text NOT NULL,
	"event" text NOT NULL,
	"submission_id" uuid,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE INDEX "operational_logs_created_at_idx" ON "operational_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "operational_logs_event_idx" ON "operational_logs" USING btree ("event");--> statement-breakpoint
CREATE INDEX "operational_logs_submission_idx" ON "operational_logs" USING btree ("submission_id");