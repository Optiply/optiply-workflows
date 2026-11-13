CREATE TABLE "app_draft_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"restored_from" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_draft_versions" ADD CONSTRAINT "app_draft_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_draft_versions" ADD CONSTRAINT "app_draft_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_draft_versions_app_idx" ON "app_draft_versions" USING btree ("app_id","updated_at" DESC NULLS LAST);