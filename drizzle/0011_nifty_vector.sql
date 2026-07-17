ALTER TABLE "submission_artifacts" ALTER COLUMN "data_base64" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_artifacts" ADD COLUMN "object_key" text;