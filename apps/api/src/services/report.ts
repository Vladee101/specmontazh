// UC 20: отчёт за период. Таблица и CSV строятся одной выборкой (v_task_report)
// по исходным плановым датам: перенос не уводит задание в другой период.
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { SystemType, TaskStatus } from '../db/types.js';
import { toCsv } from '../lib/csv.js';
import { dateTimeIn } from '../lib/dates.js';
import { SYSTEM_TYPE_LABELS, TASK_STATUS_LABELS } from '../lib/labels.js';

export interface ReportFilter {
  date_from?: string;
  date_to?: string;
  object_id?: number;
  system_type?: SystemType;
  engineer_id?: number;
  status?: TaskStatus;
}

export async function reportRows(db: Db, f: ReportFilter) {
  let q = db.selectFrom('v_task_report as v');
  if (f.date_from) q = q.where('v.original_due_date', '>=', f.date_from);
  if (f.date_to) q = q.where('v.original_due_date', '<=', f.date_to);
  if (f.object_id) q = q.where('v.object_id', '=', f.object_id);
  if (f.system_type) q = q.where('v.system_type', '=', f.system_type);
  if (f.engineer_id) q = q.where('v.assigned_engineer_id', '=', f.engineer_id);
  if (f.status) q = q.where('v.status', '=', f.status);

  return q
    .selectAll('v')
    .select(
      // Замечания: непустые комментарии проверок «устройство · проверка: текст» по порядку пунктов.
      sql<string | null>`(
        SELECT string_agg(
                 coalesce(e.name || ' · ', '') || c.check_text || ': ' || btrim(c.comment),
                 ' | ' ORDER BY c.position)
          FROM task_check c
          LEFT JOIN task_equipment te ON te.id = c.task_equipment_id
          LEFT JOIN equipment e ON e.id = te.equipment_id
         WHERE c.task_id = v.id AND btrim(coalesce(c.comment, '')) <> ''
      )`.as('check_remarks'),
    )
    .orderBy('v.original_due_date')
    .orderBy('v.task_number')
    .execute();
}

export type ReportRow = Awaited<ReturnType<typeof reportRows>>[number];

/** Замечания проверок плюс общий комментарий инженера. */
export function remarksOf(row: ReportRow): string {
  const parts: string[] = [];
  if (row.check_remarks) parts.push(row.check_remarks);
  if (row.engineer_comment?.trim()) parts.push(`Комментарий инженера: ${row.engineer_comment.trim()}`);
  return parts.join(' | ');
}

export function reportSummary(rows: ReportRow[]) {
  const cancelled = rows.filter((r) => r.status === 'cancelled').length;
  const accepted = rows.filter((r) => r.status === 'accepted').length;
  return {
    total: rows.length,
    accepted,
    // отменённые выполнением не считаются и идут отдельно
    cancelled,
    not_completed: rows.length - accepted - cancelled,
    overdue: rows.filter((r) => r.is_overdue).length,
    with_violation: rows.filter((r) => r.has_deadline_violation).length,
  };
}

/** Столбцы CSV: ключ (для тестов и описания) и русский заголовок для Excel. */
export const CSV_COLUMNS = [
  ['task_number', 'Номер задания'],
  ['object_name', 'Объект'],
  ['customer_name', 'Заказчик'],
  ['address', 'Адрес'],
  ['system_name', 'Система'],
  ['system_type', 'Тип системы'],
  ['engineer_name', 'Исполнитель'],
  ['status', 'Статус'],
  ['original_due_date', 'Исходный срок'],
  ['current_due_date', 'Текущий срок'],
  ['actual_performed_on', 'Фактическая дата'],
  ['accepted_at', 'Принято'],
  ['is_overdue', 'Просрочено'],
  ['has_deadline_violation', 'Нарушение срока'],
  ['is_partial', 'Частичный результат'],
  ['remarks', 'Замечания'],
  ['review_comment', 'Комментарий при возврате'],
  ['cancellation_reason', 'Причина отмены'],
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number][0];
export const CSV_HEADER = CSV_COLUMNS.map(([, title]) => title);

const yesNo = (v: boolean) => (v ? 'Да' : 'Нет');

export function reportCsv(rows: ReportRow[], timeZone: string): string {
  return toCsv(
    CSV_HEADER,
    rows.map((r) => [
      r.task_number,
      r.object_name,
      r.customer_name,
      r.address,
      r.system_name,
      SYSTEM_TYPE_LABELS[r.system_type],
      r.engineer_name,
      TASK_STATUS_LABELS[r.status],
      r.original_due_date,
      r.current_due_date,
      r.actual_performed_on,
      r.accepted_at ? dateTimeIn(timeZone, r.accepted_at) : null,
      yesNo(r.is_overdue),
      yesNo(r.has_deadline_violation),
      yesNo(r.is_partial),
      remarksOf(r),
      r.review_comment,
      r.cancellation_reason,
    ]),
  );
}
