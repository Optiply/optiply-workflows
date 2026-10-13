CREATE TABLE "config_var_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"config_var_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"value" text,
	"value_encrypted" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_var_values_one_value_ck" CHECK (num_nonnulls("config_var_values"."value", "config_var_values"."value_encrypted") = 1)
);
--> statement-breakpoint
CREATE TABLE "config_vars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"object_type" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_name_uq" UNIQUE NULLS NOT DISTINCT("object_type","parent_id","name"),
	CONSTRAINT "folders_object_type_ck" CHECK ("folders"."object_type" in ('resource', 'workflow'))
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid,
	"environment_id" uuid,
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_grant_uq" UNIQUE NULLS NOT DISTINCT("group_id","object_type","object_id","environment_id"),
	CONSTRAINT "permissions_object_type_ck" CHECK ("permissions"."object_type" in ('resource', 'workflow', 'folder')),
	CONSTRAINT "permissions_level_ck" CHECK ("permissions"."level" in ('use', 'edit', 'own'))
);
--> statement-breakpoint
CREATE TABLE "resource_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"folder_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_var_values" ADD CONSTRAINT "config_var_values_config_var_id_config_vars_id_fk" FOREIGN KEY ("config_var_id") REFERENCES "public"."config_vars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_var_values" ADD CONSTRAINT "config_var_values_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_var_values" ADD CONSTRAINT "config_var_values_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_configs" ADD CONSTRAINT "resource_configs_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_configs" ADD CONSTRAINT "resource_configs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_configs" ADD CONSTRAINT "resource_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "config_var_values_env_uq" ON "config_var_values" USING btree ("config_var_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_vars_name_uq" ON "config_vars" USING btree ("name");--> statement-breakpoint
CREATE INDEX "permissions_object_idx" ON "permissions" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_configs_env_uq" ON "resource_configs" USING btree ("resource_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_slug_uq" ON "resources" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "resources_folder_idx" ON "resources" USING btree ("folder_id");