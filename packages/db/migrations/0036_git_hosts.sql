ALTER TABLE "git_settings" ADD COLUMN "host" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "github_auth" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "github_app_id" text;--> statement-breakpoint
ALTER TABLE "git_settings" ADD COLUMN "api_url" text;--> statement-breakpoint
ALTER TABLE "git_settings" ADD CONSTRAINT "git_settings_host_ck" CHECK ("git_settings"."host" in ('github', 'gitlab'));--> statement-breakpoint
ALTER TABLE "git_settings" ADD CONSTRAINT "git_settings_github_auth_ck" CHECK ("git_settings"."github_auth" in ('token', 'app'));