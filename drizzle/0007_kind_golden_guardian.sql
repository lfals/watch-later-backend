ALTER TABLE "reel_submissions" ADD COLUMN "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reel_submissions" ADD COLUMN "resolution_source" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "is_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;