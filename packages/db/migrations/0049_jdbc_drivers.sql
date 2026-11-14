CREATE TABLE "jdbc_drivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"class_name" text NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"jar" "bytea" NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jdbc_drivers_name_uq" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "jdbc_drivers" ADD CONSTRAINT "jdbc_drivers_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;