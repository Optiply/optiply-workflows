CREATE TABLE "user_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"block_key" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcomes" jsonb NOT NULL,
	"assignee_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"assignee_group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"due_at" timestamp with time zone,
	"outcome" text,
	"values" jsonb,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tasks_status_ck" CHECK ("user_tasks"."status" in ('open', 'completed', 'expired', 'cancelled')),
	CONSTRAINT "user_tasks_completed_ck" CHECK (("user_tasks"."status" = 'completed') = ("user_tasks"."outcome" is not null and "user_tasks"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "user_tasks" ADD CONSTRAINT "user_tasks_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tasks" ADD CONSTRAINT "user_tasks_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tasks" ADD CONSTRAINT "user_tasks_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tasks" ADD CONSTRAINT "user_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_tasks_block_uq" ON "user_tasks" USING btree ("run_id","block_key");--> statement-breakpoint
CREATE INDEX "user_tasks_open_idx" ON "user_tasks" USING btree ("created_at") WHERE "user_tasks"."status" = 'open';