-- M16: a draft written by anything (an editor's save, a REST client, a release restored, a Git deploy or pull) tells
-- the API processes on channel `ow_collab`, so one with the draft's document open folds the new draft into it.
-- The payload is {"d": "<document key>", "r": <the new revision>}.
CREATE OR REPLACE FUNCTION "ow_collab_draft_written"() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ow_collab', json_build_object('d', TG_ARGV[0] || ':' || NEW.id, 'r', NEW.draft_revision)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ow_collab_branch_draft_written"() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ow_collab', json_build_object('d', 'branch:' || NEW.id, 'r', NEW.revision)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "workflows_collab_draft" AFTER UPDATE OF "draft_revision" ON "workflows"
  FOR EACH ROW WHEN (OLD.draft_revision IS DISTINCT FROM NEW.draft_revision)
  EXECUTE FUNCTION "ow_collab_draft_written"('workflow');
--> statement-breakpoint
CREATE TRIGGER "apps_collab_draft" AFTER UPDATE OF "draft_revision" ON "apps"
  FOR EACH ROW WHEN (OLD.draft_revision IS DISTINCT FROM NEW.draft_revision)
  EXECUTE FUNCTION "ow_collab_draft_written"('app');
--> statement-breakpoint
CREATE TRIGGER "modules_collab_draft" AFTER UPDATE OF "draft_revision" ON "modules"
  FOR EACH ROW WHEN (OLD.draft_revision IS DISTINCT FROM NEW.draft_revision)
  EXECUTE FUNCTION "ow_collab_draft_written"('module');
--> statement-breakpoint
CREATE TRIGGER "git_branch_drafts_collab_draft" AFTER UPDATE OF "revision" ON "git_branch_drafts"
  FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
  EXECUTE FUNCTION "ow_collab_branch_draft_written"();
