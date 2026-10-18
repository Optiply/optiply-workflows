CREATE TABLE "module_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module_id" uuid NOT NULL,
	"version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"notes" text,
	"git_commit" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_releases_version_ck" CHECK ("module_releases"."version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
	CONSTRAINT "module_releases_hash_ck" CHECK ("module_releases"."definition_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"folder_id" uuid,
	"draft_definition" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"live_release_id" uuid,
	"git_protected" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_object_type_ck";--> statement-breakpoint
ALTER TABLE "permissions" DROP CONSTRAINT "permissions_object_type_ck";--> statement-breakpoint
ALTER TABLE "module_releases" ADD CONSTRAINT "module_releases_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_releases" ADD CONSTRAINT "module_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_live_release_id_module_releases_id_fk" FOREIGN KEY ("live_release_id") REFERENCES "public"."module_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "module_releases_version_uq" ON "module_releases" USING btree ("module_id","version");--> statement-breakpoint
CREATE INDEX "module_releases_module_idx" ON "module_releases" USING btree ("module_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "modules_slug_uq" ON "modules" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "modules_folder_idx" ON "modules" USING btree ("folder_id");--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_object_type_ck" CHECK ("folders"."object_type" in ('resource', 'workflow', 'app', 'library_query', 'module'));--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_object_type_ck" CHECK ("permissions"."object_type" in ('resource', 'workflow', 'app', 'library_query', 'module', 'folder'));