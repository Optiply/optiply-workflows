CREATE TABLE "block_run_payloads" (
	"block_run_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb,
	"size_bytes" integer NOT NULL,
	CONSTRAINT "block_run_payloads_size_ck" CHECK ("block_run_payloads"."size_bytes" between 0 and 10485760)
);
--> statement-breakpoint
CREATE TABLE "block_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"block_key" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"epoch" integer NOT NULL,
	"port" text,
	"error" jsonb,
	"metadata" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_runs_status_ck" CHECK ("block_runs"."status" in ('pending', 'running', 'succeeded', 'errored', 'failed', 'skipped', 'waiting', 'cancelled', 'interrupted')),
	CONSTRAINT "block_runs_attempt_ck" CHECK ("block_runs"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "run_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"block_key" text,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_logs_level_ck" CHECK ("run_logs"."level" in ('log', 'info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE TABLE "workflow_draft_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_releases_version_ck" CHECK ("workflow_releases"."version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
	CONSTRAINT "workflow_releases_hash_ck" CHECK ("workflow_releases"."definition_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"release_id" uuid,
	"draft_snapshot_id" uuid,
	"environment_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb,
	"error" jsonb,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"epoch" integer DEFAULT 0 NOT NULL,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"idempotency_key" text,
	"scheduled_for" timestamp with time zone,
	"parent_run_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_status_ck" CHECK ("workflow_runs"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "workflow_runs_trigger_type_ck" CHECK ("workflow_runs"."trigger_type" in ('manual', 'webhook', 'schedule', 'workflow')),
	CONSTRAINT "workflow_runs_source_ck" CHECK (num_nonnulls("workflow_runs"."release_id", "workflow_runs"."draft_snapshot_id") = 1),
	CONSTRAINT "workflow_runs_lease_ck" CHECK ("workflow_runs"."status" <> 'running' or ("workflow_runs"."lease_owner" is not null and "workflow_runs"."lease_expires_at" is not null)),
	CONSTRAINT "workflow_runs_finished_ck" CHECK (("workflow_runs"."status" in ('succeeded', 'failed', 'cancelled')) = ("workflow_runs"."finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "workflow_triggers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_fire_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_triggers_kind_ck" CHECK ("workflow_triggers"."kind" in ('webhook', 'schedule'))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"folder_id" uuid,
	"draft_definition" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"live_release_id" uuid,
	"max_concurrent_runs" integer,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_max_concurrent_runs_ck" CHECK ("workflows"."max_concurrent_runs" is null or "workflows"."max_concurrent_runs" > 0)
);
--> statement-breakpoint
ALTER TABLE "block_run_payloads" ADD CONSTRAINT "block_run_payloads_block_run_id_block_runs_id_fk" FOREIGN KEY ("block_run_id") REFERENCES "public"."block_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block_runs" ADD CONSTRAINT "block_runs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_draft_snapshots" ADD CONSTRAINT "workflow_draft_snapshots_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_draft_snapshots" ADD CONSTRAINT "workflow_draft_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_releases" ADD CONSTRAINT "workflow_releases_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_releases" ADD CONSTRAINT "workflow_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_release_id_workflow_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."workflow_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_draft_snapshot_id_workflow_draft_snapshots_id_fk" FOREIGN KEY ("draft_snapshot_id") REFERENCES "public"."workflow_draft_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_id_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."workflow_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_parent_run_id_workflow_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_release_id_workflow_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."workflow_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_live_release_id_workflow_releases_id_fk" FOREIGN KEY ("live_release_id") REFERENCES "public"."workflow_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "block_runs_key_uq" ON "block_runs" USING btree ("run_id","block_key");--> statement-breakpoint
CREATE INDEX "run_logs_run_idx" ON "run_logs" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_draft_snapshots_revision_uq" ON "workflow_draft_snapshots" USING btree ("workflow_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_releases_version_uq" ON "workflow_releases" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_releases_workflow_idx" ON "workflow_releases" USING btree ("workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_runs_claim_idx" ON "workflow_runs" USING btree ("available_at") WHERE "workflow_runs"."status" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX "workflow_runs_lease_idx" ON "workflow_runs" USING btree ("lease_expires_at") WHERE "workflow_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_idx" ON "workflow_runs" USING btree ("workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_runs_parent_idx" ON "workflow_runs" USING btree ("parent_run_id") WHERE "workflow_runs"."parent_run_id" is not null;--> statement-breakpoint
CREATE INDEX "workflow_runs_trigger_idx" ON "workflow_runs" USING btree ("trigger_id") WHERE "workflow_runs"."trigger_id" is not null;--> statement-breakpoint
CREATE INDEX "workflow_runs_draft_snapshot_idx" ON "workflow_runs" USING btree ("draft_snapshot_id") WHERE "workflow_runs"."draft_snapshot_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency_uq" ON "workflow_runs" USING btree ("workflow_id","idempotency_key") WHERE "workflow_runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_schedule_uq" ON "workflow_runs" USING btree ("trigger_id","scheduled_for") WHERE "workflow_runs"."trigger_id" is not null and "workflow_runs"."scheduled_for" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_triggers_name_uq" ON "workflow_triggers" USING btree ("workflow_id","kind","name");--> statement-breakpoint
CREATE INDEX "workflow_triggers_due_idx" ON "workflow_triggers" USING btree ("next_fire_at") WHERE "workflow_triggers"."kind" = 'schedule' and "workflow_triggers"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_slug_uq" ON "workflows" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workflows_folder_idx" ON "workflows" USING btree ("folder_id");