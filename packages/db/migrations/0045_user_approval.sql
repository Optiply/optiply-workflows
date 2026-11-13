ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_ck" CHECK ("users"."status" in ('active', 'pending', 'invited', 'rejected'));