CREATE TABLE "npm_registries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text,
	"url" text NOT NULL,
	"token_config_var" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npm_registries_scope_uq" UNIQUE NULLS NOT DISTINCT("scope")
);
