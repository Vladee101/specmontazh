// UC 10: регламенты. Шаблон подставляется по типу системы. Активация и возобновление
// сразу запускают генерацию в той же транзакции: пустой чек-лист откатывает активацию.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { assertVersion, requireRow } from '../db/helpers.js';
import type { Role } from '../db/types.js';
import { currentUser } from '../http/auth.js';
import { today } from '../http/context.js';
import { conflict, fieldError, parse } from '../http/errors.js';
import { idParam, isoDate, LIMITS, optionalId, requiredText, systemType, version } from '../http/schemas.js';
import { generateForRegulation } from '../services/generation.js';

const manager = { config: { roles: ['manager'] as Role[] } };

const intervalValue = z.number({ error: 'Укажите периодичность' }).int('Целое число месяцев').min(1, 'Периодичность больше нуля').max(120, 'Не больше 120 месяцев');

const CreateRegulation = z.object({
  system_id: z.number().int().positive(),
  name: requiredText(LIMITS.name, 'Введите название'),
  interval_value: intervalValue,
  first_due_date: isoDate,
});
const UpdateRegulation = z.object({
  version,
  name: requiredText(LIMITS.name, 'Введите название').optional(),
  interval_value: intervalValue.optional(),
  first_due_date: isoDate.optional(),
});
const VersionOnly = z.object({ version });
const ResumeBody = z.object({ version, next_due_date: isoDate });
const ListQuery = z.object({
  q: z.string().trim().optional(),
  object_id: optionalId,
  system_id: optionalId,
  system_type: systemType.optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
});

export async function regulationRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  const notInPast = (date: string, field: string) => {
    if (date < today(ctx)) throw fieldError(field, 'Дата не может быть в прошлом');
  };

  const selectRegulation = () =>
    db
      .selectFrom('maintenance_regulation as r')
      .innerJoin('low_current_system as s', 's.id', 'r.system_id')
      .innerJoin('service_object as o', 'o.id', 's.object_id')
      .innerJoin('checklist_template as t', 't.id', 'r.template_id')
      .selectAll('r')
      .select(['s.name as system_name', 's.system_type', 'o.id as object_id', 'o.name as object_name', 't.name as template_name']);

  app.get('/regulations', manager, async (req) => {
    const q = parse(ListQuery, req.query);
    let query = selectRegulation();
    if (q.q) {
      const like = `%${q.q}%`;
      query = query.where((eb) => eb.or([eb('r.name', 'ilike', like), eb('o.name', 'ilike', like), eb('s.name', 'ilike', like)]));
    }
    if (q.object_id) query = query.where('o.id', '=', q.object_id);
    if (q.system_id) query = query.where('r.system_id', '=', q.system_id);
    if (q.system_type) query = query.where('s.system_type', '=', q.system_type as never);
    if (q.status) query = query.where('r.status', '=', q.status);
    return { items: await query.orderBy('o.name').orderBy('r.name').execute() };
  });

  app.get('/regulations/:id', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    return requireRow(await selectRegulation().where('r.id', '=', id).executeTakeFirst(), 'Регламент не найден');
  });

  app.post('/regulations', manager, async (req, reply) => {
    const body = parse(CreateRegulation, req.body);
    notInPast(body.first_due_date, 'first_due_date');
    const reg = await db.transaction().execute(async (trx) => {
      const system = requireRow(
        await trx
          .selectFrom('low_current_system as s')
          .innerJoin('service_object as o', 'o.id', 's.object_id')
          .select(['s.id', 's.system_type', 's.is_archived', 'o.is_archived as object_archived'])
          .where('s.id', '=', body.system_id)
          .forShare('s')
          .executeTakeFirst(),
        'Система не найдена',
      );
      if (system.is_archived || system.object_archived) throw conflict('archived', 'Система или объект в архиве');
      const template = await trx.selectFrom('checklist_template').select('id').where('system_type', '=', system.system_type).executeTakeFirst();
      if (!template) throw conflict('no_template', 'Для этого типа системы нет шаблона чек-листа');
      return trx
        .insertInto('maintenance_regulation')
        .values({
          system_id: body.system_id,
          template_id: template.id,
          created_by_id: currentUser(req).id,
          name: body.name,
          interval_value: body.interval_value,
          schedule_anchor_date: body.first_due_date,
          next_due_date: body.first_due_date,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    });
    reply.status(201);
    return selectRegulation().where('r.id', '=', reg.id).executeTakeFirstOrThrow();
  });

  // Изменения не переписывают созданные задания. График (периодичность, первая дата)
  // меняется только у черновика; действующий регламент — через паузу и возобновление.
  app.patch('/regulations/:id', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(UpdateRegulation, req.body);
    await db.transaction().execute(async (trx) => {
      const reg = assertVersion(await trx.selectFrom('maintenance_regulation').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), body.version, 'Регламент');
      const scheduleChanged = body.first_due_date !== undefined || (body.interval_value !== undefined && body.interval_value !== reg.interval_value);
      if (scheduleChanged && reg.status === 'active') {
        throw conflict('schedule_locked', 'График действующего регламента не меняется: приостановите регламент и задайте новую дату при возобновлении');
      }
      if (body.first_due_date !== undefined && reg.status !== 'draft') {
        throw fieldError('first_due_date', 'Первая дата меняется только у черновика');
      }
      if (body.first_due_date) notInPast(body.first_due_date, 'first_due_date');
      await trx
        .updateTable('maintenance_regulation')
        .set({
          name: body.name,
          interval_value: body.interval_value,
          ...(body.first_due_date ? { schedule_anchor_date: body.first_due_date, next_due_date: body.first_due_date } : {}),
        })
        .where('id', '=', id)
        .execute();
    });
    return selectRegulation().where('r.id', '=', id).executeTakeFirstOrThrow();
  });

  app.post('/regulations/:id/activate', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(VersionOnly, req.body);
    const created = await db.transaction().execute(async (trx) => {
      const reg = assertVersion(await trx.selectFrom('maintenance_regulation').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), body.version, 'Регламент');
      if (reg.status !== 'draft') throw conflict('invalid_status', 'Активировать можно только черновик');
      notInPast(reg.next_due_date, 'next_due_date');
      // активный непустой шаблон и неархивные система и объект проверяет триггер БД
      await trx.updateTable('maintenance_regulation').set({ status: 'active', activated_at: sql`now()` }).where('id', '=', id).execute();
      return generateForRegulation(trx, id, today(ctx), ctx.config.horizonDays);
    });
    return { regulation: await selectRegulation().where('r.id', '=', id).executeTakeFirstOrThrow(), created_tasks: created };
  });

  // На паузе задания не создаются и не копятся. Повтор безопасен.
  app.post('/regulations/:id/pause', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(VersionOnly, req.body);
    await db.transaction().execute(async (trx) => {
      const reg = requireRow(await trx.selectFrom('maintenance_regulation').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), 'Регламент не найден');
      if (reg.status === 'paused') return;
      assertVersion(reg, body.version);
      if (reg.status !== 'active') throw conflict('invalid_status', 'Приостановить можно только действующий регламент');
      await trx.updateTable('maintenance_regulation').set({ status: 'paused', paused_at: sql`now()` }).where('id', '=', id).execute();
    });
    return selectRegulation().where('r.id', '=', id).executeTakeFirstOrThrow();
  });

  // Возобновление: новая ближайшая дата, опорная дата сбрасывается на неё, пауза не восполняется.
  app.post('/regulations/:id/resume', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(ResumeBody, req.body);
    notInPast(body.next_due_date, 'next_due_date');
    const created = await db.transaction().execute(async (trx) => {
      const reg = assertVersion(await trx.selectFrom('maintenance_regulation').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), body.version, 'Регламент');
      if (reg.status !== 'paused') throw conflict('invalid_status', 'Возобновить можно только приостановленный регламент');
      await trx
        .updateTable('maintenance_regulation')
        .set({ status: 'active', paused_at: null, schedule_anchor_date: body.next_due_date, next_due_date: body.next_due_date })
        .where('id', '=', id)
        .execute();
      return generateForRegulation(trx, id, today(ctx), ctx.config.horizonDays);
    });
    return { regulation: await selectRegulation().where('r.id', '=', id).executeTakeFirstOrThrow(), created_tasks: created };
  });
}
