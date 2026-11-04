CREATE TABLE "component_bundles" (
	"hash" text PRIMARY KEY NOT NULL,
	"input_hash" text,
	"js" text NOT NULL,
	"css" text NOT NULL,
	"lock" text,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_bundles_hash_ck" CHECK ("component_bundles"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "component_libraries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"folder_id" uuid,
	"draft_definition" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"draft_lock" text,
	"live_release_id" uuid,
	"git_protected" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "component_library_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"component_library_id" uuid NOT NULL,
	"version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"lock" text,
	"uploaded" boolean DEFAULT false NOT NULL,
	"notes" text,
	"git_commit" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_library_releases_version_ck" CHECK ("component_library_releases"."version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
	CONSTRAINT "component_library_releases_hash_ck" CHECK ("component_library_releases"."definition_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "collab_documents" DROP CONSTRAINT "collab_documents_object_ck";--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_object_type_ck";--> statement-breakpoint
ALTER TABLE "git_branch_drafts" DROP CONSTRAINT "git_branch_drafts_object_ck";--> statement-breakpoint
ALTER TABLE "git_objects" DROP CONSTRAINT "git_objects_kind_ck";--> statement-breakpoint
ALTER TABLE "permissions" DROP CONSTRAINT "permissions_object_type_ck";--> statement-breakpoint
ALTER TABLE "collab_documents" ADD COLUMN "component_library_id" uuid;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD COLUMN "component_library_id" uuid;--> statement-breakpoint
ALTER TABLE "component_libraries" ADD CONSTRAINT "component_libraries_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_libraries" ADD CONSTRAINT "component_libraries_live_release_id_component_library_releases_id_fk" FOREIGN KEY ("live_release_id") REFERENCES "public"."component_library_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_libraries" ADD CONSTRAINT "component_libraries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_libraries" ADD CONSTRAINT "component_libraries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_library_releases" ADD CONSTRAINT "component_library_releases_component_library_id_component_libraries_id_fk" FOREIGN KEY ("component_library_id") REFERENCES "public"."component_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_library_releases" ADD CONSTRAINT "component_library_releases_bundle_hash_component_bundles_hash_fk" FOREIGN KEY ("bundle_hash") REFERENCES "public"."component_bundles"("hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_library_releases" ADD CONSTRAINT "component_library_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "component_bundles_input_uq" ON "component_bundles" USING btree ("input_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "component_libraries_slug_uq" ON "component_libraries" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "component_libraries_folder_idx" ON "component_libraries" USING btree ("folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "component_library_releases_version_uq" ON "component_library_releases" USING btree ("component_library_id","version");--> statement-breakpoint
CREATE INDEX "component_library_releases_library_idx" ON "component_library_releases" USING btree ("component_library_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "component_library_releases_bundle_idx" ON "component_library_releases" USING btree ("bundle_hash");--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_component_library_id_component_libraries_id_fk" FOREIGN KEY ("component_library_id") REFERENCES "public"."component_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_component_library_id_component_libraries_id_fk" FOREIGN KEY ("component_library_id") REFERENCES "public"."component_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_branch_drafts_component_library_uq" ON "git_branch_drafts" USING btree ("component_library_id","branch") WHERE "git_branch_drafts"."component_library_id" is not null;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_object_ck" CHECK (num_nonnulls("collab_documents"."workflow_id", "collab_documents"."app_id", "collab_documents"."module_id", "collab_documents"."library_query_id", "collab_documents"."component_library_id", "collab_documents"."branch_draft_id") = 1);--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_object_type_ck" CHECK ("folders"."object_type" in ('resource', 'workflow', 'app', 'library_query', 'module', 'component_library'));--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_object_ck" CHECK (num_nonnulls("git_branch_drafts"."workflow_id", "git_branch_drafts"."app_id", "git_branch_drafts"."library_query_id", "git_branch_drafts"."module_id", "git_branch_drafts"."component_library_id") = 1);--> statement-breakpoint
ALTER TABLE "git_objects" ADD CONSTRAINT "git_objects_kind_ck" CHECK ("git_objects"."kind" in ('workflow', 'app', 'library_query', 'module', 'component_library', 'resource', 'config_var'));--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_object_type_ck" CHECK ("permissions"."object_type" in ('resource', 'workflow', 'app', 'library_query', 'module', 'component_library', 'folder'));--> statement-breakpoint
-- M25: a component library's draft written by anything tells the API processes, as for the other kinds (0022, 0026).
CREATE TRIGGER "component_libraries_collab_draft" AFTER UPDATE OF "draft_revision" ON "component_libraries"
  FOR EACH ROW WHEN (OLD.draft_revision IS DISTINCT FROM NEW.draft_revision)
  EXECUTE FUNCTION "ow_collab_draft_written"('components');
--> statement-breakpoint
-- M25: a deleted library takes its Git deploy state along (0031).
CREATE TRIGGER "component_libraries_git_object_deleted" AFTER DELETE ON "component_libraries"
  FOR EACH ROW EXECUTE FUNCTION "ow_git_object_deleted"('component_library');
