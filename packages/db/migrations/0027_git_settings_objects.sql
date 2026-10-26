ALTER TABLE "git_objects" DROP CONSTRAINT "git_objects_kind_ck";--> statement-breakpoint
ALTER TABLE "config_var_values" ADD COLUMN "local" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "config_vars" ADD COLUMN "git_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_configs" ADD COLUMN "overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "git_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "git_objects" ADD CONSTRAINT "git_objects_kind_ck" CHECK ("git_objects"."kind" in ('workflow', 'app', 'library_query', 'module', 'resource', 'config_var'));