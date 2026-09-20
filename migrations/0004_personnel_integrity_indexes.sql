-- 补齐 M1/M2 的完整性约束与查询索引；不引入尚未确认的 EXCLUDE 能力。
ALTER TABLE "person"
  ADD CONSTRAINT "CK_person_employee_no_length" CHECK (char_length("employee_no") between 1 and 32),
  ADD CONSTRAINT "CK_person_full_name_length" CHECK (char_length("full_name") between 1 and 64),
  ADD CONSTRAINT "CK_person_mobile_length" CHECK ("mobile" is null or char_length("mobile") <= 32),
  ADD CONSTRAINT "CK_person_deactivation_reason_length" CHECK ("deactivation_reason" is null or char_length("deactivation_reason") <= 200),
  ADD CONSTRAINT "CK_person_employment_type" CHECK ("employment_type" in ('full_time', 'part_time', 'contract', 'intern', 'other')),
  ADD CONSTRAINT "CK_person_status" CHECK ("status" in ('draft', 'active', 'inactive')),
  ADD CONSTRAINT "CK_person_employment_dates" CHECK ("employment_end_date" is null or "employment_end_date" >= "employment_start_date"),
  ADD CONSTRAINT "CK_person_deactivation_reason_required" CHECK ("status" <> 'inactive' or "deactivation_reason" is not null);
--> statement-breakpoint
ALTER TABLE "assignment"
  ADD CONSTRAINT "CK_assignment_department_id_length" CHECK (char_length("department_id") between 1 and 64),
  ADD CONSTRAINT "CK_assignment_status" CHECK ("status" in ('pending', 'current', 'closed', 'retracted')),
  ADD CONSTRAINT "CK_assignment_dates" CHECK ("effective_to" is null or "effective_to" >= "effective_from"),
  ADD CONSTRAINT "CK_assignment_no_self_report" CHECK ("reports_to_person_id" is null or "reports_to_person_id" <> "person_id");
--> statement-breakpoint
CREATE INDEX "IDX_person_roster_active" ON "person" USING btree ("status", "created_at") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "IDX_person_full_name" ON "person" USING btree ("full_name");
--> statement-breakpoint
CREATE INDEX "IDX_assignment_person_effective" ON "assignment" USING btree ("person_id", "effective_from");
--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_assignment_person_effective_from" ON "assignment" USING btree ("person_id", "effective_from") WHERE "status" <> 'retracted';
--> statement-breakpoint
CREATE INDEX "IDX_assignment_reports_to" ON "assignment" USING btree ("reports_to_person_id");
--> statement-breakpoint
CREATE INDEX "IDX_assignment_department" ON "assignment" USING btree ("department_id");
