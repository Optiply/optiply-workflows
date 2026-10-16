CREATE TABLE "git_deploys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"commit" text NOT NULL,
	"previous_commit" text,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"object_id" uuid,
	"tree_sha" text,
	"commit" text NOT NULL,
	"status" text NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_objects_kind_slug_uq" UNIQUE("kind","slug"),
	CONSTRAINT "git_objects_kind_ck" CHECK ("git_objects"."kind" in ('workflow', 'app')),
	CONSTRAINT "git_objects_status_ck" CHECK ("git_objects"."status" in ('deployed', 'problem', 'missing'))
);
--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN "git_commit" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "git_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "deployed_commit" text;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "deploy_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "deploy_requested_by" text;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "deploy_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_releases" ADD COLUMN "git_commit" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "git_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "git_deploys_started_idx" ON "git_deploys" USING btree ("started_at");