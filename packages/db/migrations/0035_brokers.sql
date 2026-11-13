CREATE TABLE "kinesis_checkpoints" (
	"trigger_id" uuid NOT NULL,
	"shard_id" text NOT NULL,
	"sequence_number" text,
	"finished" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kinesis_checkpoints_trigger_id_shard_id_pk" PRIMARY KEY("trigger_id","shard_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "workflow_triggers" DROP CONSTRAINT "workflow_triggers_kind_ck";--> statement-breakpoint
ALTER TABLE "kinesis_checkpoints" ADD CONSTRAINT "kinesis_checkpoints_trigger_id_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_ck" CHECK ("workflow_runs"."trigger_type" in ('manual', 'webhook', 'schedule', 'workflow', 'pubsub', 'git', 'sqs', 'kafka', 'rabbitmq', 'kinesis'));--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_kind_ck" CHECK ("workflow_triggers"."kind" in ('webhook', 'schedule', 'pubsub', 'sqs', 'kafka', 'rabbitmq', 'kinesis'));