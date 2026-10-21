CREATE TABLE "collab_documents" (
	"key" text PRIMARY KEY NOT NULL,
	"workflow_id" uuid,
	"app_id" uuid,
	"module_id" uuid,
	"branch_draft_id" uuid,
	"state" "bytea" NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collab_documents_object_ck" CHECK (num_nonnulls("collab_documents"."workflow_id", "collab_documents"."app_id", "collab_documents"."module_id", "collab_documents"."branch_draft_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "collab_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_key" text NOT NULL,
	"update" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_branch_draft_id_git_branch_drafts_id_fk" FOREIGN KEY ("branch_draft_id") REFERENCES "public"."git_branch_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_updates" ADD CONSTRAINT "collab_updates_document_key_collab_documents_key_fk" FOREIGN KEY ("document_key") REFERENCES "public"."collab_documents"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collab_updates_document_idx" ON "collab_updates" USING btree ("document_key","id");