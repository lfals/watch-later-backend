CREATE TYPE "public"."watch_status" AS ENUM('want_to_watch', 'watching', 'watched');--> statement-breakpoint
CREATE TYPE "public"."work_type" AS ENUM('movie', 'series', 'anime');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "watchlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"status" "watch_status" DEFAULT 'want_to_watch' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "work_type" NOT NULL,
	"title" text NOT NULL,
	"original_title" text,
	"release_year" text,
	"synopsis" text,
	"poster_url" text,
	"tmdb_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_user_work_unique" ON "watchlist_entries" USING btree ("user_id","work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "works_tmdb_id_unique" ON "works" USING btree ("tmdb_id");