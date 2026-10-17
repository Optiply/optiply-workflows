CREATE TABLE "git_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"secrets" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_settings_singleton_uq" UNIQUE("singleton"),
	CONSTRAINT "git_settings_singleton_ck" CHECK ("git_settings"."singleton")
);
--> statement-breakpoint
ALTER TABLE "git_settings" ADD CONSTRAINT "git_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;