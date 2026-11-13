CREATE TABLE "js_bundles" (
	"input_hash" text PRIMARY KEY NOT NULL,
	"dependencies" jsonb NOT NULL,
	"state" text NOT NULL,
	"bundle_hash" text,
	"js" text,
	"lock" text,
	"versions" jsonb,
	"size_bytes" integer,
	"warnings" jsonb,
	"error" jsonb,
	"log" text,
	"built_at" timestamp with time zone,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "js_bundles_state_ck" CHECK ("js_bundles"."state" in ('ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN "js_lock" text;--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN "js_bundle_hash" text;--> statement-breakpoint
ALTER TABLE "workflow_releases" ADD COLUMN "js_lock" text;--> statement-breakpoint
ALTER TABLE "workflow_releases" ADD COLUMN "js_bundle_hash" text;--> statement-breakpoint
CREATE INDEX "js_bundles_bundle_hash_ix" ON "js_bundles" USING btree ("bundle_hash");