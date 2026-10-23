CREATE TABLE "pubsub_deliveries" (
	"trigger_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"last_run_id" uuid,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pubsub_deliveries_trigger_id_message_id_pk" PRIMARY KEY("trigger_id","message_id"),
	CONSTRAINT "pubsub_deliveries_outcome_ck" CHECK ("pubsub_deliveries"."outcome" in ('succeeded', 'failed', 'released'))
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "workflow_triggers" DROP CONSTRAINT "workflow_triggers_kind_ck";--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pubsub_deliveries" ADD CONSTRAINT "pubsub_deliveries_trigger_id_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pubsub_deliveries" ADD CONSTRAINT "pubsub_deliveries_last_run_id_workflow_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pubsub_deliveries_updated_idx" ON "pubsub_deliveries" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_ck" CHECK ("workflow_runs"."trigger_type" in ('manual', 'webhook', 'schedule', 'workflow', 'pubsub'));--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_kind_ck" CHECK ("workflow_triggers"."kind" in ('webhook', 'schedule', 'pubsub'));