ALTER TABLE "pubsub_deliveries" RENAME TO "queue_deliveries";--> statement-breakpoint
ALTER TABLE "queue_deliveries" RENAME CONSTRAINT "pubsub_deliveries_trigger_id_message_id_pk" TO "queue_deliveries_trigger_id_message_id_pk";--> statement-breakpoint
ALTER TABLE "queue_deliveries" RENAME CONSTRAINT "pubsub_deliveries_trigger_id_workflow_triggers_id_fk" TO "queue_deliveries_trigger_id_workflow_triggers_id_fk";--> statement-breakpoint
ALTER TABLE "queue_deliveries" RENAME CONSTRAINT "pubsub_deliveries_last_run_id_workflow_runs_id_fk" TO "queue_deliveries_last_run_id_workflow_runs_id_fk";--> statement-breakpoint
ALTER INDEX "pubsub_deliveries_updated_idx" RENAME TO "queue_deliveries_updated_idx";--> statement-breakpoint
ALTER TABLE "queue_deliveries" DROP CONSTRAINT "pubsub_deliveries_outcome_ck";--> statement-breakpoint
ALTER TABLE "queue_deliveries" ADD CONSTRAINT "queue_deliveries_outcome_ck" CHECK ("queue_deliveries"."outcome" in ('succeeded', 'failed', 'released', 'dead_lettered', 'dropped'));--> statement-breakpoint
ALTER TABLE "workflow_triggers" DROP CONSTRAINT "workflow_triggers_kind_ck";--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_kind_ck" CHECK ("workflow_triggers"."kind" in ('webhook', 'schedule', 'pubsub', 'sqs', 'kafka'));--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_ck" CHECK ("workflow_runs"."trigger_type" in ('manual', 'webhook', 'schedule', 'workflow', 'pubsub', 'git', 'sqs', 'kafka'));
