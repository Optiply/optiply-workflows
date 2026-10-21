CREATE TABLE "webhook_rate_windows" (
	"trigger_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "webhook_rate_windows_trigger_id_window_start_pk" PRIMARY KEY("trigger_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "webhook_rejections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger_id" uuid NOT NULL,
	"environment_id" uuid,
	"status" integer NOT NULL,
	"reason" text NOT NULL,
	"message" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_rate_windows" ADD CONSTRAINT "webhook_rate_windows_trigger_id_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_rejections" ADD CONSTRAINT "webhook_rejections_trigger_id_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_rejections" ADD CONSTRAINT "webhook_rejections_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_rate_windows_expires_idx" ON "webhook_rate_windows" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_rejections_trigger_idx" ON "webhook_rejections" USING btree ("trigger_id","created_at");