ALTER TABLE "git_branch_drafts" DROP CONSTRAINT "git_branch_drafts_object_ck";--> statement-breakpoint
ALTER TABLE "git_objects" DROP CONSTRAINT "git_objects_kind_ck";--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD COLUMN "library_query_id" uuid;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD COLUMN "module_id" uuid;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_library_query_id_library_queries_id_fk" FOREIGN KEY ("library_query_id") REFERENCES "public"."library_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_branch_drafts_library_query_uq" ON "git_branch_drafts" USING btree ("library_query_id","branch") WHERE "git_branch_drafts"."library_query_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "git_branch_drafts_module_uq" ON "git_branch_drafts" USING btree ("module_id","branch") WHERE "git_branch_drafts"."module_id" is not null;--> statement-breakpoint
ALTER TABLE "git_branch_drafts" ADD CONSTRAINT "git_branch_drafts_object_ck" CHECK (num_nonnulls("git_branch_drafts"."workflow_id", "git_branch_drafts"."app_id", "git_branch_drafts"."library_query_id", "git_branch_drafts"."module_id") = 1);--> statement-breakpoint
ALTER TABLE "git_objects" ADD CONSTRAINT "git_objects_kind_ck" CHECK ("git_objects"."kind" in ('workflow', 'app', 'library_query', 'module'));