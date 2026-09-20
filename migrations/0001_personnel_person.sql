-- 人员主档案：工号唯一，保留草稿/在职/停用生命周期所需字段。
CREATE TABLE "person" (
	"employee_no" text NOT NULL,
	"full_name" text NOT NULL,
	"mobile" text,
	"email" text,
	"employment_type" text NOT NULL,
	"employment_start_date" date NOT NULL,
	"employment_end_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"deactivated_on" date,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "UQ_person_employee_no" UNIQUE("employee_no")
);
--> statement-breakpoint
ALTER TABLE "public"."person" RENAME CONSTRAINT "person_pkey" TO "PK_person";
