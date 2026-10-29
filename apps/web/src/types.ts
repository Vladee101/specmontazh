import type { CheckResult, SystemType, TaskStatus } from './labels';

export interface TaskListItem {
  id: number;
  task_number: string;
  status: TaskStatus;
  original_due_date: string;
  current_due_date: string;
  actual_performed_on: string | null;
  object_id: number;
  object_name: string;
  address: string;
  system_id: number;
  system_name: string;
  system_type: SystemType;
  assigned_engineer_id: number | null;
  engineer_name: string | null;
  is_overdue: boolean;
  has_deadline_violation: boolean;
  is_partial: boolean;
}

export interface TaskCheck {
  id: number;
  position: number;
  section_name: string | null;
  check_text: string;
  is_required: boolean;
  result: CheckResult | null;
  comment: string | null;
  checked_at: string | null;
  checked_by_name: string | null;
  equipment_id: number | null;
  equipment_name: string | null;
  equipment_location: string | null;
}

export interface TaskDetail extends TaskListItem {
  version: number;
  customer_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  accepted_at: string | null;
  engineer_comment: string | null;
  review_comment: string | null;
  cancellation_reason: string | null;
  created_at: string;
  started_at: string | null;
  submitted_at: string | null;
  cancelled_at: string | null;
  regulation_id: number;
  regulation_name: string;
  reviewed_by_name: string | null;
  equipment: { task_equipment_id: number; equipment_id: number; name: string; equipment_type: string; location: string | null; lifecycle_status: string }[];
  checks: TaskCheck[];
}

export type HistoryEvent =
  | { kind: 'status'; id: number; changed_at: string; previous_status: TaskStatus | null; new_status: TaskStatus; comment: string | null; actual_performed_on: string | null; changed_by_name: string | null }
  | { kind: 'assignment'; id: number; changed_at: string; changed_by_name: string; new_engineer_name: string; previous_engineer_name: string | null }
  | { kind: 'deadline'; id: number; changed_at: string; previous_due_date: string; new_due_date: string; reason: string; changed_by_name: string };

export interface Engineer {
  id: number;
  full_name: string;
  is_active: boolean;
  open_tasks_count: number;
}

export interface ServiceObject {
  id: number;
  name: string;
  customer_name: string;
  address: string;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  is_archived: boolean;
  archived_at: string | null;
  version: number;
  systems_count?: number;
}

export interface LcSystem {
  id: number;
  object_id: number;
  object_name?: string;
  name: string;
  system_type: SystemType;
  location: string | null;
  description: string | null;
  is_archived: boolean;
  version: number;
  equipment_count?: number;
}

export interface Equipment {
  id: number;
  system_id: number;
  name: string;
  equipment_type: string;
  model: string | null;
  serial_number: string | null;
  location: string | null;
  installed_on: string | null;
  lifecycle_status: 'active' | 'decommissioned';
  decommissioned_on: string | null;
  decommission_reason: string | null;
  version: number;
}

export interface Regulation {
  id: number;
  system_id: number;
  template_id: number;
  name: string;
  interval_value: number;
  schedule_anchor_date: string;
  next_due_date: string;
  status: 'draft' | 'active' | 'paused';
  paused_at: string | null;
  activated_at: string | null;
  version: number;
  system_name: string;
  system_type: SystemType;
  object_id: number;
  object_name: string;
  template_name: string;
}

export interface TemplateItem {
  id: number;
  template_id: number;
  position: number;
  section_name: string | null;
  check_text: string;
  target_type: 'system' | 'equipment';
  equipment_type_filter: string[] | null;
  is_required: boolean;
}

export interface Template {
  id: number;
  name: string;
  system_type: SystemType;
  is_active: boolean;
  version: number;
  items_count?: number;
}
