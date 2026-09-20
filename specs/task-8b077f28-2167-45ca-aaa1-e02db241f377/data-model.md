# 人员管理功能 数据模型（PostgreSQL / Drizzle）

基线：spec.md（Q1/Q4、R1–R7）与 plan.md 的 M1–M3 拆分。列名 snake_case，与 `contracts/openapi.yaml` 的 camelCase 字段一一对应。三表归属 `personnel` 模块；落地包路径与 migrations 目录以宿主 M0 确认为准。本节仅为设计，未对任何数据库执行迁移。

## Table Purpose
- **person**：人员主档案，同一自然人仅一条（R1）。仅存身份、联系方式、雇佣信息与在职状态（Q4 范围，无证件号/薪酬/银行账户）。
- **assignment**：部门、岗位、汇报关系的任职区间与生效日期；支撑调岗、撤销与停用后名称快照追溯（F1/F3/F5、R3/R5）。
- **change_record**：字段级历史与审计——动作、字段前后值、操作人、时间、生效期间（F5/R7/AC-010），仅追加。

## Fields and Types
### person
- id uuid PK（gen_random_uuid()）；employee_no text NOT NULL（1–32）；full_name text NOT NULL（1–64）
- mobile text NULL（≤32）；email text NULL（格式在 domain 层校验）
- employment_type text NOT NULL（full_time / part_time / contract / intern / other）
- employment_start_date date NOT NULL；employment_end_date date NULL
- status text NOT NULL default 'draft'（draft / active / inactive）
- deactivated_on date NULL；deactivation_reason text NULL（≤200，停用时必填）
- created_at / updated_at timestamptz NOT NULL default now()

### assignment
- id uuid PK；person_id uuid NOT NULL → person.id
- department_id text NOT NULL（1–64）；department_name text NOT NULL（快照）；position_id text NULL；position_name text NOT NULL
- reports_to_person_id uuid NULL → person.id
- effective_from date NOT NULL；effective_to date NULL
- status text NOT NULL default 'pending'（pending / current / closed / retracted）
- created_at / updated_at timestamptz NOT NULL default now()

### change_record
- id uuid PK；person_id uuid NOT NULL → person.id
- action text NOT NULL（create / update / assignment_change / assignment_retract / status_change / delete_attempt）
- field_name text NOT NULL；old_value text NULL；new_value text NULL
- operator_id text NOT NULL；operator_name text NULL（操作人名称快照）
- occurred_at timestamptz NOT NULL default now()；effective_from date NULL；effective_to date NULL

## Keys and Constraints
- person：`UNIQUE (employee_no)` 全表唯一、停用后不复用（R1/AC-002，仅经授权且无引用的物理删除才释放）；CHECK status 枚举；CHECK (status<>'inactive' OR deactivation_reason IS NOT NULL)；CHECK employment_end_date 为空或不早于 employment_start_date。
- assignment：CHECK status 枚举；CHECK (effective_to IS NULL OR effective_to >= effective_from)；CHECK reports_to_person_id IS NULL OR <> person_id（R4 禁自引用）；防重叠 `EXCLUDE USING gist (person_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&) WHERE (status <> 'retracted')`（R3/AC-005，依赖 btree_gist）；「上级须在职、汇报链无环」无法用 CHECK 表达，由 domain 层递归校验强制（R4）。
- change_record：无任何更新/删除接口；追加写由应用角色权限保障（见 Sensitive Data）。
- 全部外键 ON DELETE RESTRICT，无级联物理删除（AC-007）。

## Indexes
- person：UNIQUE employee_no；部分索引 `(status, created_at DESC) WHERE status='active'` 支撑默认在册分页（AC-003/AC-006）；`(full_name)` 供等值/前缀检索。模糊检索（trigram）因无数据量目标暂不启用。
- assignment：`(person_id, effective_from)`；`UNIQUE (person_id, effective_from) WHERE status<>'retracted'`；GIST 索引由 EXCLUDE 约束自带；`(reports_to_person_id)` 供汇报链遍历；`(department_id)` 供在册部门筛选。
- change_record：`(person_id, occurred_at DESC)` 供 F5 历史分页。

## Relationships
- person 1—N assignment（person_id）；任一时刻至多一条 status='current' 的区间，由领域事务与防重叠约束共同保证。
- assignment N—1 person（reports_to_person_id，可空）：汇报上级须为在职人员（R4，domain 层校验）。
- person 1—N change_record；契约中 PersonDetail.currentAssignment 与历史生效期间为查询派生，不做冗余列。
- 部门与岗位仅以「标识 + 名称快照」存储，不建组织主数据表（需求未定义组织管理流程）。

## Lifecycle
- person.status：draft → active → inactive 单向流转；非法流转由 domain 层拒绝（R2，409 invalid_status_transition）。F1 建档成功即进入 active（保存草稿场景保留 draft）。
- assignment.status：pending（未生效）→ current → closed（被新区间关闭或人员停用）；pending → retracted（R3 撤销，仅尚未生效可用）。
- 停用（F4）：置 inactive 并记录 deactivated_on/reason；档案与历史保留，不再进入默认在册列表与可指派集合（AC-006）。
- 物理删除：仅「无任何业务引用且已获授权」时允许；引用判定来自既有模块（M0 确认），FK RESTRICT 从存储层兜底（AC-007）。

## Sensitive Data
- 字段范围严守 Q4：不建证件号、薪酬、银行账户列；AC-009 由测试对字段定义白名单复核。
- mobile/email 属个人信息：结构化日志不记录字段值（architecture Observability）；change_record 前后值可能含联系信息，仅经历史查询接口向 HR 角色回读（AC-008）。
- 审计不可改写（R7）：应用层无更新/删除路径；数据库层对应用角色仅授予 change_record 的 INSERT、SELECT，撤销 UPDATE/DELETE——该收口依赖迁移环境的实际 grant，尚未验证。

## Migration Notes
- M1：person + employee_no 唯一 + 在册状态索引；M2：assignment + btree_gist 扩展 + EXCLUDE 重叠约束 + 汇报外键；M3：change_record + 仅追加角色授权。三次仅向前迁移，置于宿主 migrations/，按宿主流程提交并等待审批。
- `CREATE EXTENSION btree_gist` 需数据库管理权限；实施环境不可用时回退为「domain 层区间校验 + advisory lock」方案，需重新评审后变更本节。
- 全部为新表，不动既有 schema 与数据（兼容性 / AC-011）；以上约束均未在实际数据库执行验证。
