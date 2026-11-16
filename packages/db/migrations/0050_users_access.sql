ALTER TABLE "users" ADD COLUMN "access" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_access_ck" CHECK ("users"."access" in ('full', 'apps_only'));