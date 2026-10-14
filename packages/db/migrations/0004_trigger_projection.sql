ALTER TABLE "workflow_triggers" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD COLUMN "alias_shape" text;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD COLUMN "last_fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_triggers_alias_uq" ON "workflow_triggers" USING btree ("alias_shape") WHERE "workflow_triggers"."alias_shape" is not null;