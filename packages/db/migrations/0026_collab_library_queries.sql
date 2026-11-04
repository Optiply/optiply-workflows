ALTER TABLE "collab_documents" DROP CONSTRAINT "collab_documents_object_ck";--> statement-breakpoint
ALTER TABLE "collab_documents" ADD COLUMN "library_query_id" uuid;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_library_query_id_library_queries_id_fk" FOREIGN KEY ("library_query_id") REFERENCES "public"."library_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_object_ck" CHECK (num_nonnulls("collab_documents"."workflow_id", "collab_documents"."app_id", "collab_documents"."module_id", "collab_documents"."library_query_id", "collab_documents"."branch_draft_id") = 1);--> statement-breakpoint
-- M21: a library query's draft written by anything tells the API processes, as for workflows, apps and modules (0022).
CREATE TRIGGER "library_queries_collab_draft" AFTER UPDATE OF "draft_revision" ON "library_queries"
  FOR EACH ROW WHEN (OLD.draft_revision IS DISTINCT FROM NEW.draft_revision)
  EXECUTE FUNCTION "ow_collab_draft_written"('library');
