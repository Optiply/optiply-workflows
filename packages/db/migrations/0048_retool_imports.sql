CREATE TABLE "retool_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"retool_key" text NOT NULL,
	"retool_name" text NOT NULL,
	"app_id" uuid,
	"workflow_id" uuid,
	"report" jsonb NOT NULL,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retool_imports_key_uq" UNIQUE("kind","retool_key"),
	CONSTRAINT "retool_imports_target_ck" CHECK (("retool_imports"."kind" = 'app' and "retool_imports"."app_id" is not null and "retool_imports"."workflow_id" is null) or ("retool_imports"."kind" = 'workflow' and "retool_imports"."workflow_id" is not null and "retool_imports"."app_id" is null))
);
--> statement-breakpoint
CREATE TABLE "retool_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"retool_key" text NOT NULL,
	"resource_id" uuid,
	"workflow_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retool_mappings_key_uq" UNIQUE("kind","retool_key"),
	CONSTRAINT "retool_mappings_target_ck" CHECK (("retool_mappings"."kind" = 'resource' and "retool_mappings"."resource_id" is not null and "retool_mappings"."workflow_id" is null) or ("retool_mappings"."kind" = 'workflow' and "retool_mappings"."workflow_id" is not null and "retool_mappings"."resource_id" is null))
);
--> statement-breakpoint
ALTER TABLE "retool_imports" ADD CONSTRAINT "retool_imports_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retool_imports" ADD CONSTRAINT "retool_imports_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retool_imports" ADD CONSTRAINT "retool_imports_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retool_mappings" ADD CONSTRAINT "retool_mappings_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retool_mappings" ADD CONSTRAINT "retool_mappings_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retool_mappings" ADD CONSTRAINT "retool_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;