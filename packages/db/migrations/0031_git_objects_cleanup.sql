-- M22 review: an object deleted on the instance (through the API or not) takes its Git deploy state along, so a
-- later deploy of a repo without it doesn't list a row for something no longer here. `object_id` points at one of
-- six tables, so this is a trigger per table rather than a foreign key. Rows left by deletes before this go too.
CREATE OR REPLACE FUNCTION "ow_git_object_deleted"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "git_objects" WHERE "kind" = TG_ARGV[0] AND "object_id" = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "workflows_git_object_deleted" AFTER DELETE ON "workflows"
  FOR EACH ROW EXECUTE FUNCTION "ow_git_object_deleted"('workflow');
--> statement-breakpoint
CREATE TRIGGER "apps_git_object_deleted" AFTER DELETE ON "apps"
  FOR EACH ROW EXECUTE FUNCTION "ow_git_object_deleted"('app');
--> statement-breakpoint
CREATE TRIGGER "library_queries_git_object_deleted" AFTER DELETE ON "library_queries"
  FOR EACH ROW EXECUTE FUNCTION "ow_git_object_deleted"('library_query');
--> statement-breakpoint
CREATE TRIGGER "modules_git_object_deleted" AFTER DELETE ON "modules"
  FOR EACH ROW EXECUTE FUNCTION "ow_git_object_deleted"('module');
--> statement-breakpoint
CREATE TRIGGER "resources_git_object_deleted" AFTER DELETE ON "resources"
  FOR EACH ROW EXECUTE FUNCTION "ow_git_object_deleted"('resource');
--> statement-breakpoint
CREATE TRIGGER "config_vars_git_object_deleted" AFTER DELETE ON "config_vars"
  FOR EACH ROW EXECUTE FUNCTION "ow_git_object_deleted"('config_var');
--> statement-breakpoint
DELETE FROM "git_objects" g WHERE "object_id" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "workflows" WHERE g."kind" = 'workflow' AND "id" = g."object_id"
  UNION ALL SELECT 1 FROM "apps" WHERE g."kind" = 'app' AND "id" = g."object_id"
  UNION ALL SELECT 1 FROM "library_queries" WHERE g."kind" = 'library_query' AND "id" = g."object_id"
  UNION ALL SELECT 1 FROM "modules" WHERE g."kind" = 'module' AND "id" = g."object_id"
  UNION ALL SELECT 1 FROM "resources" WHERE g."kind" = 'resource' AND "id" = g."object_id"
  UNION ALL SELECT 1 FROM "config_vars" WHERE g."kind" = 'config_var' AND "id" = g."object_id"
);
