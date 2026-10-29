// UC 12–15, 19, 21: список, карточка, история и команды заданий.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRow } from '../db/helpers.js';
import type { Role, TaskStatus } from '../db/types.js';
import { currentUser } from '../http/auth.js';
import { today } from '../http/context.js';
import { parse } from '../http/errors.js';
import { idParam, isoDate, LIMITS, optionalId, optionalText, pageResult, pagination, requiredText, systemType, taskStatus, version } from '../http/schemas.js';
import {
  acceptTask,
  assertTaskAccess,
  assignTask,
  cancelTask,
  rescheduleTask,
  returnTask,
  saveChecks,
  startTask,
  submitTask,
  type CommandContext,
  type TaskRow,
} from '../services/tasks.js';

const manager = { config: { roles: ['manager'] as Role[] } };
const engineer = { config: { roles: ['engineer'] as Role[] } };
const both = { config: { roles: ['manager', 'engineer'] as Role[] } };

const ListQuery = pagination.extend({
  q: z.string().trim().optional(),
  object_id: optionalId,
  system_id: optionalId,
  system_type: systemType.optional(),
  engineer_id: optionalId,
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(taskStatus).optional()),
  view: z.enum(['all', 'overdue', 'in_review', 'cancelled', 'open']).default('all'),
  due_from: isoDate.optional(),
  due_to: isoDate.optional(),
});

const checkResult = z.enum(['passed', 'deviation', 'not_applicable', 'not_checked'], { error: 'Неизвестный результат' }).nullable();
const engineerComment = optionalText(LIMITS.text).optional();

const Bodies = {
  assign: z.object({ version, engineer_id: z.number({ error: 'Выберите инженера' }).int().positive() }),
  reschedule: z.object({ version, new_due_date: isoDate, reason: requiredText(LIMITS.text, 'Укажите причину переноса') }),
  cancel: z.object({ version, reason: requiredText(LIMITS.text, 'Укажите причину отмены') }),
  return: z.object({ version, comment: requiredText(LIMITS.text, 'Опишите, что требуется исправить') }),
  versionOnly: z.object({ version }),
  checks: z.object({
    version,
    checks: z.array(z.object({ id: z.number().int().positive(), result: checkResult, comment: optionalText(LIMITS.text) })).default([]),
    engineer_comment: engineerComment,
  }),
  submit: z.object({ version, actual_performed_on: isoDate, engineer_comment: engineerComment }),
};

export async function taskRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  // имя объекта, адрес и контакты читаются из карточки объекта на момент запроса:
  // изменение контактов в объекте сразу видно в задании (как название оборудования в BR-07).
  const loadDetails = async (taskId: number) => {
    const task = requireRow(
      await db
        .selectFrom('v_task_report as v')
        .innerJoin('maintenance_task as t', 't.id', 'v.id')
        .innerJoin('maintenance_regulation as r', 'r.id', 't.regulation_id')
        .leftJoin('users as rv', 'rv.id', 't.reviewed_by_id')
        .innerJoin('service_object as o', 'o.id', 'v.object_id')
        .selectAll('v')
        .select([
          't.version', 't.created_at', 't.started_at', 't.submitted_at', 't.cancelled_at', 't.regulation_id',
          'r.name as regulation_name', 'rv.full_name as reviewed_by_name',
          'o.contact_name', 'o.contact_phone',
        ])
        .where('v.id', '=', taskId)
        .executeTakeFirst(),
      'Задание не найдено',
    );
    const equipment = await db
      .selectFrom('task_equipment as te')
      .innerJoin('equipment as e', 'e.id', 'te.equipment_id')
      .select(['te.id as task_equipment_id', 'e.id as equipment_id', 'e.name', 'e.equipment_type', 'e.location', 'e.lifecycle_status'])
      .where('te.task_id', '=', taskId)
      .orderBy('e.name')
      .execute();
    // название оборудования читается из карточки (BR-07), текст проверки — из копии в задании
    const checks = await db
      .selectFrom('task_check as c')
      .leftJoin('task_equipment as te', 'te.id', 'c.task_equipment_id')
      .leftJoin('equipment as e', 'e.id', 'te.equipment_id')
      .leftJoin('users as u', 'u.id', 'c.checked_by_id')
      .select([
        'c.id', 'c.position', 'c.section_name', 'c.check_text', 'c.is_required', 'c.result', 'c.comment', 'c.checked_at',
        'u.full_name as checked_by_name', 'e.id as equipment_id', 'e.name as equipment_name', 'e.location as equipment_location',
      ])
      .where('c.task_id', '=', taskId)
      .orderBy('c.position')
      .execute();
    return { ...task, equipment, checks };
  };

  const commandCtx = (req: FastifyRequest, trx: CommandContext['trx']): CommandContext => ({
    trx,
    user: currentUser(req),
    today: today(ctx),
    timeZone: ctx.config.timeZone,
  });

  const run = async (req: FastifyRequest, fn: (c: CommandContext, id: number) => Promise<TaskRow | { task: TaskRow }>) => {
    const { id } = parse(idParam, req.params);
    await db.transaction().execute((trx) => fn(commandCtx(req, trx), id));
    return loadDetails(id);
  };

  // UC 19: список с фильтрами и пагинацией. Инженер видит только свои задания.
  app.get('/tasks', both, async (req) => {
    const q = parse(ListQuery, req.query);
    const user = currentUser(req);
    let query = db.selectFrom('v_task_report as v');
    if (user.role === 'engineer') query = query.where('v.assigned_engineer_id', '=', user.id);
    if (q.q) {
      const like = `%${q.q}%`;
      query = query.where((eb) => eb.or([eb('v.task_number', 'ilike', like), eb('v.object_name', 'ilike', like)]));
    }
    if (q.object_id) query = query.where('v.object_id', '=', q.object_id);
    if (q.system_id) query = query.where('v.system_id', '=', q.system_id);
    if (q.system_type) query = query.where('v.system_type', '=', q.system_type as never);
    if (q.engineer_id) query = query.where('v.assigned_engineer_id', '=', q.engineer_id);
    if (q.status?.length) query = query.where('v.status', 'in', q.status as TaskStatus[]);
    if (q.due_from) query = query.where('v.original_due_date', '>=', q.due_from);
    if (q.due_to) query = query.where('v.original_due_date', '<=', q.due_to);
    if (q.view === 'overdue') query = query.where('v.is_overdue', '=', true);
    if (q.view === 'in_review') query = query.where('v.status', '=', 'in_review');
    if (q.view === 'cancelled') query = query.where('v.status', '=', 'cancelled');
    if (q.view === 'open') query = query.where('v.status', 'not in', ['accepted', 'cancelled']);

    const { total } = await query.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
    const items = await query
      .select([
        'v.id', 'v.task_number', 'v.status', 'v.original_due_date', 'v.current_due_date', 'v.actual_performed_on',
        'v.object_id', 'v.object_name', 'v.address', 'v.system_id', 'v.system_name', 'v.system_type',
        'v.assigned_engineer_id', 'v.engineer_name', 'v.is_overdue', 'v.has_deadline_violation', 'v.is_partial',
      ])
      .orderBy('v.original_due_date', 'desc')
      .orderBy('v.id', 'desc')
      .limit(q.page_size)
      .offset((q.page - 1) * q.page_size)
      .execute();
    return pageResult(items, total, q.page, q.page_size);
  });

  app.get('/tasks/:id', both, async (req) => {
    const { id } = parse(idParam, req.params);
    const task = requireRow(await db.selectFrom('maintenance_task').select(['id', 'assigned_engineer_id']).where('id', '=', id).executeTakeFirst(), 'Задание не найдено');
    assertTaskAccess(task, currentUser(req)); // AT-01: чужое задание — 403
    return loadDetails(id);
  });

  // История статусов, назначений и переносов с автором и временем (новые сверху).
  app.get('/tasks/:id/history', both, async (req) => {
    const { id } = parse(idParam, req.params);
    const task = requireRow(await db.selectFrom('maintenance_task').select(['id', 'assigned_engineer_id']).where('id', '=', id).executeTakeFirst(), 'Задание не найдено');
    assertTaskAccess(task, currentUser(req));

    const statuses = await db
      .selectFrom('task_status_history as h')
      .leftJoin('users as u', 'u.id', 'h.changed_by_id')
      .select(['h.id', 'h.changed_at', 'h.previous_status', 'h.new_status', 'h.comment', 'h.actual_performed_on', 'u.full_name as changed_by_name'])
      .where('h.task_id', '=', id)
      .execute();
    const assignments = await db
      .selectFrom('task_assignment_history as h')
      .innerJoin('users as by', 'by.id', 'h.changed_by_id')
      .innerJoin('users as nu', 'nu.id', 'h.new_engineer_id')
      .leftJoin('users as pu', 'pu.id', 'h.previous_engineer_id')
      .select(['h.id', 'h.changed_at', 'by.full_name as changed_by_name', 'nu.full_name as new_engineer_name', 'pu.full_name as previous_engineer_name'])
      .where('h.task_id', '=', id)
      .execute();
    const deadlines = await db
      .selectFrom('task_deadline_change as h')
      .innerJoin('users as by', 'by.id', 'h.changed_by_id')
      .select(['h.id', 'h.changed_at', 'h.previous_due_date', 'h.new_due_date', 'h.reason', 'by.full_name as changed_by_name'])
      .where('h.task_id', '=', id)
      .execute();

    const events = [
      ...statuses.map((e) => ({ kind: 'status' as const, ...e })),
      ...assignments.map((e) => ({ kind: 'assignment' as const, ...e })),
      ...deadlines.map((e) => ({ kind: 'deadline' as const, ...e })),
    ].sort((a, b) => b.changed_at.getTime() - a.changed_at.getTime() || b.id - a.id);
    return { items: events };
  });

  app.post('/tasks/:id/assign', manager, (req) => {
    const b = parse(Bodies.assign, req.body);
    return run(req, (c, id) => assignTask(c, id, b.version, b.engineer_id));
  });
  app.post('/tasks/:id/reschedule', manager, (req) => {
    const b = parse(Bodies.reschedule, req.body);
    return run(req, (c, id) => rescheduleTask(c, id, b.version, b.new_due_date, b.reason));
  });
  app.post('/tasks/:id/cancel', manager, (req) => {
    const b = parse(Bodies.cancel, req.body);
    return run(req, (c, id) => cancelTask(c, id, b.version, b.reason));
  });
  app.post('/tasks/:id/return', manager, (req) => {
    const b = parse(Bodies.return, req.body);
    return run(req, (c, id) => returnTask(c, id, b.version, b.comment));
  });
  app.post('/tasks/:id/accept', manager, (req) => {
    const b = parse(Bodies.versionOnly, req.body);
    return run(req, (c, id) => acceptTask(c, id, b.version));
  });
  app.post('/tasks/:id/start', engineer, (req) => {
    const b = parse(Bodies.versionOnly, req.body);
    return run(req, (c, id) => startTask(c, id, b.version));
  });
  app.put('/tasks/:id/checks', engineer, (req) => {
    const b = parse(Bodies.checks, req.body);
    return run(req, (c, id) => saveChecks(c, id, b.version, b.checks, b.engineer_comment));
  });
  app.post('/tasks/:id/submit', engineer, (req) => {
    const b = parse(Bodies.submit, req.body);
    return run(req, (c, id) => submitTask(c, id, b.version, b.actual_performed_on, b.engineer_comment));
  });
}

