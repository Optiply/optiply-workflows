CREATE TABLE "maintenance_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_result" jsonb
);
--> statement-breakpoint
CREATE INDEX "workflow_runs_finished_idx" ON "workflow_runs" USING btree ("finished_at") WHERE "workflow_runs"."finished_at" is not null;