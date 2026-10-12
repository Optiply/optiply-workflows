CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"object_type" text,
	"object_id" text,
	"environment_id" uuid,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"oidc_subject" text,
	"password_hash" text,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit_events" USING btree ("object_type","object_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "environments_slug_uq" ON "environments" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_uq" ON "groups" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_system_kind_uq" ON "groups" USING btree ("system_kind") WHERE "groups"."system_kind" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_subject_uq" ON "users" USING btree ("oidc_subject");