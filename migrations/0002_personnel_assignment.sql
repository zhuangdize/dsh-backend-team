-- 任职记录：通过受限外键关联人员主档案。
CREATE TABLE "assignment" (
	"person_id" uuid NOT NULL,
	"department_id" text NOT NULL,
	"department_name" text NOT NULL,
	"position_id" text,
	"position_name" text NOT NULL,
	"reports_to_person_id" uuid,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "FK_assignment_person" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "FK_assignment_reports_to_person" FOREIGN KEY ("reports_to_person_id") REFERENCES "public"."person"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "public"."assignment" RENAME CONSTRAINT "assignment_pkey" TO "PK_assignment";
