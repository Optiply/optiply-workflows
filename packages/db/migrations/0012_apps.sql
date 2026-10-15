CREATE TABLE "app_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_releases_version_ck" CHECK ("app_releases"."version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
	CONSTRAINT "app_releases_hash_ck" CHECK ("app_releases"."definition_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"folder_id" uuid,
	"draft_definition" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"live_release_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_object_type_ck";--> statement-breakpoint
ALTER TABLE "permissions" DROP CONSTRAINT "permissions_object_type_ck";--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_live_release_id_app_releases_id_fk" FOREIGN KEY ("live_release_id") REFERENCES "public"."app_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_releases_version_uq" ON "app_releases" USING btree ("app_id","version");--> statement-breakpoint
CREATE INDEX "app_releases_app_idx" ON "app_releases" USING btree ("app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "apps_slug_uq" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "apps_folder_idx" ON "apps" USING btree ("folder_id");--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_object_type_ck" CHECK ("folders"."object_type" in ('resource', 'workflow', 'app'));--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_object_type_ck" CHECK ("permissions"."object_type" in ('resource', 'workflow', 'app', 'folder'));