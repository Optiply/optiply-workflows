CREATE TABLE "git_branch_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid,
	"app_id" uuid,
	"branch" text NOT NULL,
	"definition" jsonb NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"base_commit" text NOT NULL,
	"branch_exists" boolean NOT NULL,
	"committed_commit" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_branch_drafts_object_ck" CHECK (num_nonnulls("git_branch_drafts"."workflow_id", "git_branch_drafts"."app_id") = 1)
);
--> statement-breakpoint
DROP INDEX "workflow_draft_snapshots_revision_uq";--> statement-breakpoint
ALTER TABLE "workflow_draft_snapshots" ADD COLUMN "branch_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_branch_drafts_workflow_uq" ON "git_branch_drafts" USING btree ("workflow_id","branch") WHERE "git_branch_drafts"."workflow_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "git_branch_drafts_app_uq" ON "git_branch_drafts" USING btree ("app_id","branch") WHERE "git_branch_drafts"."app_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_draft_snapshots_branch_revision_uq" ON "workflow_draft_snapshots" USING btree ("branch_draft_id","revision") WHERE "workflow_draft_snapshots"."branch_draft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_draft_snapshots_revision_uq" ON "workflow_draft_snapshots" USING btree ("workflow_id","revision") WHERE "workflow_draft_snapshots"."branch_draft_id" is null;