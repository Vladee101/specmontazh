// Команды заданий (UC 12–15, 21). Каждая команда — одна транзакция: строка задания
// блокируется FOR UPDATE, присланная version сверяется с текущей (иначе 409),
// смена статуса и запись истории идут вместе. Допустимые переходы дополнительно
// проверяет триггер trg_task_guard.
import { sql } from 'kysely';
import type { Trx } from '../db/index.js';
import type { CheckResult, MaintenanceTaskTable, TaskStatus } from '../db/types.js';
import type { SessionUser } from '../http/context.js';
import { badRequest, conflict, fieldError, forbidden, notFound, versionConflict, type FieldErrors } from '../http/errors.js';
import { dateIn } from '../lib/dates.js';
import { TASK_STATUS_LABELS } from '../lib/labels.js';
import type { Selectable } from 'kysely';

export type TaskRow = Selectable<MaintenanceTaskTable>;

export interface CommandContext {
  trx: Trx;
  user: SessionUser;
  today: string;
  timeZone: string;
}

/** Блокирует задание и проверяет доступ: руководитель — любое, инженер — только назначенное ему. */
export async function lockTask(trx: Trx, taskId: number, user: SessionUser): Promise<TaskRow> {
  const task = await trx.selectFrom('maintenance_task').selectAll().where('id', '=', taskId).forUpdate().executeTakeFirst();
  if (!task) throw notFound('Задание не найдено');
  assertTaskAccess(task, user);
  return task;
}

export function assertTaskAccess(task: { assigned_engineer_id: number | null }, user: SessionUser): void {
  if (user.role === 'manager') return;
  if (user.role === 'engineer' && task.assigned_engineer_id === user.id) return;
  throw forbidden('Нет доступа к заданию');
}

function checkVersion(task: TaskRow, expected: number) {
  if (task.version !== expected) throw versionConflict();
}

function requireStatus(task: TaskRow, allowed: TaskStatus[], message?: string) {
  if (!allowed.includes(task.status)) {
    throw conflict('invalid_status', message ?? `Действие недоступно в статусе «${TASK_STATUS_LABELS[task.status]}»`);
  }
}

function requireManager(user: SessionUser) {
  if (user.role !== 'manager') throw forbidden();
}

function requireAssignedEngineer(task: TaskRow, user: SessionUser) {
  if (user.role !== 'engineer' || task.assigned_engineer_id !== user.id) throw forbidden('Действие доступно только назначенному инженеру');
}

async function writeStatus(
  c: CommandContext,
  task: TaskRow,
  newStatus: TaskStatus,
  values: Partial<Omit<TaskRow, 'id' | 'version' | 'status'>>,
  history: { comment?: string | null; actual_performed_on?: string | null } = {},
): Promise<TaskRow> {
  const updated = await c.trx
    .updateTable('maintenance_task')
    .set({ ...values, status: newStatus })
    .where('id', '=', task.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await c.trx
    .insertInto('task_status_history')
    .values({
      task_id: task.id,
      changed_by_id: c.user.id,
      previous_status: task.status,
      new_status: newStatus,
      comment: history.comment ?? null,
      actual_performed_on: history.actual_performed_on ?? null,
    })
    .execute();
  return updated;
}

// ---------- Руководитель ----------

/** UC 12: назначение и замена исполнителя. «Назначено» ставится только при первом назначении. */
export async function assignTask(c: CommandContext, taskId: number, expectedVersion: number, engineerId: number): Promise<TaskRow> {
  requireManager(c.user);
  const task = await lockTask(c.trx, taskId, c.user);
  checkVersion(task, expectedVersion);
  if (task.status === 'in_review') throw conflict('invalid_status', 'Задание на проверке: сначала верните его на доработку');
  requireStatus(task, ['created', 'assigned', 'in_progress', 'rework']);
  if (task.assigned_engineer_id === engineerId) throw conflict('same_engineer', 'Этот инженер уже назначен');

  const engineer = await c.trx.selectFrom('users').select(['id', 'role', 'is_active']).where('id', '=', engineerId).forShare().executeTakeFirst();
  if (!engineer || engineer.role !== 'engineer' || !engineer.is_active) {
    throw fieldError('engineer_id', 'Назначить можно только активного инженера');
  }

  await c.trx
    .insertInto('task_assignment_history')
    .values({ task_id: task.id, previous_engineer_id: task.assigned_engineer_id, new_engineer_id: engineerId, changed_by_id: c.user.id })
    .execute();
  if (task.status === 'created') return writeStatus(c, task, 'assigned', { assigned_engineer_id: engineerId });
  return c.trx.updateTable('maintenance_task').set({ assigned_engineer_id: engineerId }).where('id', '=', task.id).returningAll().executeTakeFirstOrThrow();
}

/** UC 13: перенос срока. Исходный срок и график регламента не меняются. */
export async function rescheduleTask(c: CommandContext, taskId: number, expectedVersion: number, newDueDate: string, reason: string): Promise<TaskRow> {
  requireManager(c.user);
  const task = await lockTask(c.trx, taskId, c.user);
  checkVersion(task, expectedVersion);
  requireStatus(task, ['created', 'assigned', 'in_progress', 'in_review', 'rework'], 'Принятое или отменённое задание не переносится');
  if (newDueDate === task.current_due_date) throw fieldError('new_due_date', 'Новый срок совпадает с текущим');
  if (newDueDate < c.today) throw fieldError('new_due_date', 'Новый срок не может быть в прошлом');

  await c.trx
    .insertInto('task_deadline_change')
    .values({ task_id: task.id, changed_by_id: c.user.id, previous_due_date: task.current_due_date, new_due_date: newDueDate, reason })
    .execute();
  return c.trx.updateTable('maintenance_task').set({ current_due_date: newDueDate }).where('id', '=', task.id).returningAll().executeTakeFirstOrThrow();
}

/** UC 21: отмена с причиной. Повтор безопасен; результаты сохраняются; дубль не создаётся. */
export async function cancelTask(c: CommandContext, taskId: number, expectedVersion: number, reason: string): Promise<TaskRow> {
  requireManager(c.user);
  const task = await lockTask(c.trx, taskId, c.user);
  if (task.status === 'cancelled') return task;
  checkVersion(task, expectedVersion);
  requireStatus(task, ['created', 'assigned', 'in_progress', 'in_review', 'rework'], 'Принятое задание не отменяется');
  return writeStatus(c, task, 'cancelled', { cancelled_at: sql<Date>`now()` as never, cancelled_by_id: c.user.id, cancellation_reason: reason }, { comment: reason });
}

/** UC 15: возврат на доработку с обязательным комментарием. */
export async function returnTask(c: CommandContext, taskId: number, expectedVersion: number, comment: string): Promise<TaskRow> {
  requireManager(c.user);
  const task = await lockTask(c.trx, taskId, c.user);
  checkVersion(task, expectedVersion);
  requireStatus(task, ['in_review'], 'Вернуть можно только задание на проверке');
  return writeStatus(c, task, 'rework', { review_comment: comment, reviewed_by_id: c.user.id }, { comment });
}

/** UC 15: приёмка. Сервер заново проверяет полноту: пустой или «не проверено» обязательный пункт блокирует. */
export async function acceptTask(c: CommandContext, taskId: number, expectedVersion: number): Promise<TaskRow> {
  requireManager(c.user);
  const task = await lockTask(c.trx, taskId, c.user);
  checkVersion(task, expectedVersion);
  requireStatus(task, ['in_review'], 'Принять можно только задание на проверке');
  const blocking = await c.trx
    .selectFrom('task_check')
    .select(['id', 'result'])
    .where('task_id', '=', task.id)
    .where('is_required', '=', true)
    .where((eb) => eb.or([eb('result', 'is', null), eb('result', '=', 'not_checked')]))
    .execute();
  if (blocking.length > 0) {
    throw conflict('partial_result', 'Частичное ТО принять нельзя: есть обязательные пункты без результата или «Не проверено». Верните задание на доработку или отмените его.', {
      check_ids: blocking.map((b) => b.id),
    });
  }
  return writeStatus(c, task, 'accepted', { accepted_at: sql<Date>`now()` as never, reviewed_by_id: c.user.id, is_partial: false });
}

// ---------- Инженер ----------

/** Начало ТО: «Назначено» → «В работе». */
export async function startTask(c: CommandContext, taskId: number, expectedVersion: number): Promise<TaskRow> {
  const task = await lockTask(c.trx, taskId, c.user);
  requireAssignedEngineer(task, c.user);
  checkVersion(task, expectedVersion);
  requireStatus(task, ['assigned'], 'Начать можно только назначенное задание');
  return writeStatus(c, task, 'in_progress', { started_at: sql<Date>`now()` as never });
}

export interface CheckInput {
  id: number;
  result: CheckResult | null;
  comment: string | null;
}

const EDITABLE: TaskStatus[] = ['in_progress', 'rework'];

/** UC 14: пакетное сохранение черновика. Всё или ничего; автор и время — только у изменённых пунктов. */
export async function saveChecks(
  c: CommandContext,
  taskId: number,
  expectedVersion: number,
  checks: CheckInput[],
  engineerComment: string | null | undefined,
): Promise<{ task: TaskRow; changed: number }> {
  const task = await lockTask(c.trx, taskId, c.user);
  requireAssignedEngineer(task, c.user);
  checkVersion(task, expectedVersion);
  requireStatus(task, EDITABLE, 'Результаты можно менять только в работе или на доработке');

  const existing = await c.trx.selectFrom('task_check').select(['id', 'result', 'comment']).where('task_id', '=', task.id).execute();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const errors: FieldErrors = {};
  checks.forEach((ch, i) => {
    if (!byId.has(ch.id)) errors[`checks[${i}].id`] = 'Пункт не относится к этому заданию';
    else if (ch.result && ch.result !== 'passed' && !ch.comment) {
      errors[`checks[${i}].comment`] = ch.result === 'not_applicable' ? 'Нужно обоснование' : ch.result === 'not_checked' ? 'Нужна причина' : 'Опишите замечание';
    }
  });
  if (Object.keys(errors).length > 0) throw badRequest('Проверьте результаты проверок', errors);

  let changed = 0;
  for (const ch of checks) {
    const old = byId.get(ch.id)!;
    if (old.result === ch.result && old.comment === ch.comment) continue;
    changed++;
    await c.trx
      .updateTable('task_check')
      .set(
        ch.result
          ? { result: ch.result, comment: ch.comment, checked_by_id: c.user.id, checked_at: sql<Date>`now()` as never }
          : { result: null, comment: ch.comment, checked_by_id: null, checked_at: null },
      )
      .where('id', '=', ch.id)
      .execute();
  }

  let updated = task;
  if (engineerComment !== undefined && engineerComment !== task.engineer_comment) {
    updated = await c.trx.updateTable('maintenance_task').set({ engineer_comment: engineerComment }).where('id', '=', task.id).returningAll().executeTakeFirstOrThrow();
  } else if (changed > 0) {
    // изменение проверок — тоже изменение задания: version растёт, чтобы руководитель не принял устаревшую картину
    updated = await c.trx.updateTable('maintenance_task').set({ engineer_comment: sql`engineer_comment` }).where('id', '=', task.id).returningAll().executeTakeFirstOrThrow();
  }
  return { task: updated, changed };
}

/** UC 14: отправка на проверку. Пустой обязательный пункт блокирует; is_partial считает сервер. */
export async function submitTask(
  c: CommandContext,
  taskId: number,
  expectedVersion: number,
  actualPerformedOn: string,
  engineerComment: string | null | undefined,
): Promise<TaskRow> {
  const task = await lockTask(c.trx, taskId, c.user);
  requireAssignedEngineer(task, c.user);
  checkVersion(task, expectedVersion);
  requireStatus(task, EDITABLE, 'Отправить можно только задание в работе или на доработке');

  const created = dateIn(c.timeZone, task.created_at);
  if (actualPerformedOn > c.today) throw fieldError('actual_performed_on', 'Фактическая дата не может быть в будущем');
  if (actualPerformedOn < created) throw fieldError('actual_performed_on', `Фактическая дата не раньше создания задания (${created})`);

  const required = await c.trx.selectFrom('task_check').select(['id', 'result']).where('task_id', '=', task.id).where('is_required', '=', true).execute();
  const empty = required.filter((r) => r.result === null);
  if (empty.length > 0) {
    throw conflict('required_checks_empty', `Не заполнены обязательные пункты: ${empty.length}. Отправка невозможна.`, { check_ids: empty.map((r) => r.id) });
  }
  const isPartial = required.some((r) => r.result === 'not_checked');

  return writeStatus(
    c,
    task,
    'in_review',
    {
      submitted_at: sql<Date>`now()` as never,
      actual_performed_on: actualPerformedOn,
      is_partial: isPartial,
      ...(engineerComment !== undefined ? { engineer_comment: engineerComment } : {}),
    },
    { actual_performed_on: actualPerformedOn, comment: isPartial ? 'Частичный результат' : null },
  );
}
