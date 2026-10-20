CREATE TABLE "library_queries" (
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
CREATE TABLE "library_query_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_query_id" uuid NOT NULL,
	"version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"notes" text,
	"git_commit" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_query_releases_version_ck" CHECK ("library_query_releases"."version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
	CONSTRAINT "library_query_releases_hash_ck" CHECK ("library_query_releases"."definition_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_object_type_ck";--> statement-breakpoint
ALTER TABLE "permissions" DROP CONSTRAINT "permissions_object_type_ck";--> statement-breakpoint
ALTER TABLE "library_queries" ADD CONSTRAINT "library_queries_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_queries" ADD CONSTRAINT "library_queries_live_release_id_library_query_releases_id_fk" FOREIGN KEY ("live_release_id") REFERENCES "public"."library_query_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_queries" ADD CONSTRAINT "library_queries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_queries" ADD CONSTRAINT "library_queries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_query_releases" ADD CONSTRAINT "library_query_releases_library_query_id_library_queries_id_fk" FOREIGN KEY ("library_query_id") REFERENCES "public"."library_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_query_releases" ADD CONSTRAINT "library_query_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_queries_slug_uq" ON "library_queries" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "library_queries_folder_idx" ON "library_queries" USING btree ("folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_query_releases_version_uq" ON "library_query_releases" USING btree ("library_query_id","version");--> statement-breakpoint
CREATE INDEX "library_query_releases_query_idx" ON "library_query_releases" USING btree ("library_query_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_object_type_ck" CHECK ("folders"."object_type" in ('resource', 'workflow', 'app', 'library_query'));--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_object_type_ck" CHECK ("permissions"."object_type" in ('resource', 'workflow', 'app', 'library_query', 'folder'));