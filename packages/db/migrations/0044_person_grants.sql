ALTER TABLE "permissions" DROP CONSTRAINT "permissions_grant_uq";--> statement-breakpoint
ALTER TABLE "permissions" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permissions_user_idx" ON "permissions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_grant_uq" UNIQUE NULLS NOT DISTINCT("group_id","user_id","object_type","object_id","environment_id");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_subject_ck" CHECK (("permissions"."group_id" is null) <> ("permissions"."user_id" is null));