ALTER TYPE "public"."submission_status" ADD VALUE 'scraping' BEFORE 'failed';--> statement-breakpoint
ALTER TYPE "public"."submission_status" ADD VALUE 'identifying' BEFORE 'failed';--> statement-breakpoint
ALTER TYPE "public"."submission_status" ADD VALUE 'identified' BEFORE 'failed';--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD COLUMN "identified_title" text;--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD COLUMN "failure_code" text;