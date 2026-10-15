CREATE TABLE "managed_databases" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"schema_name" text NOT NULL,
	"role_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "system_kind" text;--> statement-breakpoint
ALTER TABLE "managed_databases" ADD CONSTRAINT "managed_databases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resources_system_kind_uq" ON "resources" USING btree ("system_kind") WHERE "resources"."system_kind" is not null;