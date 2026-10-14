ALTER TABLE "workflow_runs" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;