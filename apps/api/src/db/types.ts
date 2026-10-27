// Типы таблиц для Kysely. Источник истины — db/schema.sql; при изменении схемы
// этот файл правится вручную. bigint приходят как number (см. db/index.ts),
// date — как строка YYYY-MM-DD, timestamptz — как Date.
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type DateOnly = string;

export type Role = 'admin' | 'manager' | 'engineer';
export type SystemType = 'fire_alarm' | 'evacuation_alert' | 'security_alarm' | 'video_surveillance';
export type RegulationStatus = 'draft' | 'active' | 'paused';
export type TaskStatus = 'created' | 'assigned' | 'in_progress' | 'in_review' | 'rework' | 'accepted' | 'cancelled';
export type CheckResult = 'passed' | 'deviation' | 'not_applicable' | 'not_checked';
export type TargetType = 'system' | 'equipment';

export interface UsersTable {
  id: Generated<number>;
  login: string;
  password_hash: string;
  full_name: string;
  role: Role;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  version: Generated<number>;
}

export interface ServiceObjectTable {
  id: Generated<number>;
  created_by_id: number;
  name: string;
  customer_name: string;
  address: string;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  is_archived: Generated<boolean>;
  archived_at: NullableTimestamp;
  created_at: Generated<Date>;
  version: Generated<number>;
}

export interface LowCurrentSystemTable {
  id: Generated<number>;
  object_id: number;
  name: string;
  system_type: SystemType;
  location: string | null;
  description: string | null;
  is_archived: Generated<boolean>;
  archived_at: NullableTimestamp;
  version: Generated<number>;
}

export interface EquipmentTable {
  id: Generated<number>;
  system_id: number;
  name: string;
  equipment_type: string;
  model: string | null;
  serial_number: string | null;
  location: string | null;
  installed_on: DateOnly | null;
  lifecycle_status: Generated<'active' | 'decommissioned'>;
  decommissioned_on: DateOnly | null;
  decommission_reason: string | null;
  version: Generated<number>;
}

export interface ChecklistTemplateTable {
  id: Generated<number>;
  name: string;
  system_type: SystemType;
  is_active: Generated<boolean>;
  version: Generated<number>;
}

export interface TemplateItemTable {
  id: Generated<number>;
  template_id: number;
  position: number;
  section_name: string | null;
  check_text: string;
  target_type: TargetType;
  // jsonb: массив типов оборудования; на запись передаётся JSON-строкой
  equipment_type_filter: ColumnType<string[] | null, string | null, string | null>;
  is_required: Generated<boolean>;
}

export interface MaintenanceRegulationTable {
  id: Generated<number>;
  system_id: number;
  template_id: number;
  created_by_id: number;
  name: string;
  interval_value: number;
  interval_unit: Generated<'month'>;
  schedule_anchor_date: DateOnly;
  next_due_date: DateOnly;
  status: Generated<RegulationStatus>;
  paused_at: NullableTimestamp;
  activated_at: NullableTimestamp;
  version: Generated<number>;
}

export interface MaintenanceTaskTable {
  id: Generated<number>;
  regulation_id: number;
  system_id: number;
  assigned_engineer_id: number | null;
  reviewed_by_id: number | null;
  cancelled_by_id: number | null;
  task_number: Generated<string>;
  status: Generated<TaskStatus>;
  original_due_date: DateOnly;
  current_due_date: DateOnly;
  actual_performed_on: DateOnly | null;
  started_at: NullableTimestamp;
  submitted_at: NullableTimestamp;
  accepted_at: NullableTimestamp;
  is_partial: Generated<boolean>;
  engineer_comment: string | null;
  review_comment: string | null;
  cancelled_at: NullableTimestamp;
  cancellation_reason: string | null;
  created_at: Generated<Date>;
  version: Generated<number>;
}

export interface TaskEquipmentTable {
  id: Generated<number>;
  task_id: number;
  equipment_id: number;
}

export interface TaskCheckTable {
  id: Generated<number>;
  task_id: number;
  task_equipment_id: number | null;
  source_template_item_id: number | null;
  checked_by_id: number | null;
  position: number;
  section_name: string | null;
  check_text: string;
  is_required: boolean;
  result: CheckResult | null;
  comment: string | null;
  checked_at: NullableTimestamp;
}

export interface TaskDeadlineChangeTable {
  id: Generated<number>;
  task_id: number;
  changed_by_id: number;
  previous_due_date: DateOnly;
  new_due_date: DateOnly;
  reason: string;
  changed_at: Generated<Date>;
}

export interface TaskAssignmentHistoryTable {
  id: Generated<number>;
  task_id: number;
  previous_engineer_id: number | null;
  new_engineer_id: number;
  changed_by_id: number;
  changed_at: Generated<Date>;
}

export interface TaskStatusHistoryTable {
  id: Generated<number>;
  task_id: number;
  changed_by_id: number | null;
  previous_status: TaskStatus | null;
  new_status: TaskStatus;
  comment: string | null;
  actual_performed_on: DateOnly | null;
  changed_at: Generated<Date>;
}

export interface SessionsTable {
  token_hash: string;
  user_id: number;
  csrf_token: string;
  created_at: Generated<Date>;
  last_seen_at: Timestamp;
}

export interface TaskReportView {
  id: number;
  task_number: string;
  status: TaskStatus;
  original_due_date: DateOnly;
  current_due_date: DateOnly;
  actual_performed_on: DateOnly | null;
  accepted_at: Date | null;
  is_partial: boolean;
  engineer_comment: string | null;
  review_comment: string | null;
  cancellation_reason: string | null;
  assigned_engineer_id: number | null;
  object_id: number;
  object_name: string;
  customer_name: string;
  address: string;
  system_id: number;
  system_name: string;
  system_type: SystemType;
  engineer_name: string | null;
  is_overdue: boolean;
  has_deadline_violation: boolean;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  service_object: ServiceObjectTable;
  low_current_system: LowCurrentSystemTable;
  equipment: EquipmentTable;
  checklist_template: ChecklistTemplateTable;
  template_item: TemplateItemTable;
  maintenance_regulation: MaintenanceRegulationTable;
  maintenance_task: MaintenanceTaskTable;
  task_equipment: TaskEquipmentTable;
  task_check: TaskCheckTable;
  task_deadline_change: TaskDeadlineChangeTable;
  task_assignment_history: TaskAssignmentHistoryTable;
  task_status_history: TaskStatusHistoryTable;
  sessions: SessionsTable;
  v_task_report: TaskReportView;
  schema_migrations: SchemaMigrationsTable;
}
