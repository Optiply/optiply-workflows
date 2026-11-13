CREATE TABLE "personal_access_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_access_tokens_hash_ck" CHECK ("personal_access_tokens"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_tokens_hash_uq" ON "personal_access_tokens" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "personal_access_tokens_user_idx" ON "personal_access_tokens" USING btree ("user_id");