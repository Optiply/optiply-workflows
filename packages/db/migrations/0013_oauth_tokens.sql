CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_config_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid,
	"tokens" text NOT NULL,
	"expires_at" timestamp with time zone,
	"scope" text,
	"account" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"consent_hash" text NOT NULL,
	"connected_by" uuid,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_owner_uq" UNIQUE NULLS NOT DISTINCT("resource_config_id","user_id"),
	CONSTRAINT "oauth_tokens_status_ck" CHECK ("oauth_tokens"."status" in ('active', 'reconnect'))
);
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_resource_config_id_resource_configs_id_fk" FOREIGN KEY ("resource_config_id") REFERENCES "public"."resource_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_tokens_user_idx" ON "oauth_tokens" USING btree ("user_id");