-- M23: Python package sets the builder resolved for draft runs (requirements -> lock and env), and the lock a
-- release keeps so its live runs install exactly what was published.
CREATE TABLE "python_envs" (
	"requirements_hash" text PRIMARY KEY NOT NULL,
	"requirements" jsonb NOT NULL,
	"state" text NOT NULL,
	"lock" jsonb,
	"env_id" text,
	"size_bytes" bigint,
	"error" jsonb,
	"log" text,
	"built_at" timestamp with time zone,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_releases" ADD COLUMN "python_lock" jsonb;