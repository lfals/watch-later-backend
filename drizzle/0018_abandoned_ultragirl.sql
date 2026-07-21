CREATE TABLE "stremio_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stremio_connections" ADD CONSTRAINT "stremio_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stremio_connections_user_unique" ON "stremio_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stremio_connections_token_hash_unique" ON "stremio_connections" USING btree ("token_hash");