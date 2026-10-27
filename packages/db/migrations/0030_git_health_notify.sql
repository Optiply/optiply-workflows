ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "notify_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "notified_problems" jsonb;--> statement-breakpoint
ALTER TABLE "git_settings" ADD CONSTRAINT "git_settings_notify_workflow_id_workflows_id_fk" FOREIGN KEY ("notify_workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_ck" CHECK ("workflow_runs"."trigger_type" in ('manual', 'webhook', 'schedule', 'workflow', 'pubsub', 'git'));