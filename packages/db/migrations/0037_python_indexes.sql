CREATE TABLE "python_indexes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"username" text,
	"password_config_var" text,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "python_indexes_mode_ck" CHECK ("python_indexes"."mode" in ('primary', 'extra'))
);
--> statement-breakpoint
ALTER TABLE "python_envs" ADD COLUMN "index_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "python_indexes_slug_uq" ON "python_indexes" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "python_envs" ADD CONSTRAINT "python_envs_index_id_python_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."python_indexes"("id") ON DELETE cascade ON UPDATE no action;