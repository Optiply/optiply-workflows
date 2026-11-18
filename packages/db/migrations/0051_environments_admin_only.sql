ALTER TABLE "environments" ADD COLUMN "admin_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_default_not_admin_only_ck" CHECK (not ("environments"."is_default" and "environments"."admin_only"));--> statement-breakpoint
UPDATE "environments" SET "admin_only" = true WHERE "slug" = 'staging' AND NOT "is_default";
