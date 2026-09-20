-- 字段级历史与审计记录：只追加，不提供更新/删除路径。
CREATE TABLE "change_record" (
	"person_id" uuid NOT NULL,
	"action" text NOT NULL,
	"field_name" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"operator_id" text NOT NULL,
	"operator_name" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "CK_change_record_action" CHECK ("action" in ('create', 'update', 'assignment_change', 'assignment_retract', 'status_change', 'delete_attempt'))
);
--> statement-breakpoint
ALTER TABLE "change_record" ADD CONSTRAINT "FK_change_record_person" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "IDX_change_record_person_occurred_at" ON "change_record" USING btree ("person_id", "occurred_at");
--> statement-breakpoint
ALTER TABLE "public"."change_record" RENAME CONSTRAINT "change_record_pkey" TO "PK_change_record";
