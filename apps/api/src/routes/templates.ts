// Шаблоны чек-листов (руководитель). Шаблонов ровно четыре — по одному на тип системы,
// их создаёт seed. Правка пунктов не затрагивает выданные задания: в task_check
// хранится копия, ссылка на удалённый пункт обнуляется (AT-22).
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Trx } from '../db/index.js';
import { assertVersion, requireRow } from '../db/helpers.js';
import type { Role } from '../db/types.js';
import { badRequest, conflict, parse } from '../http/errors.js';
import { LIMITS, optionalText, requiredText, version } from '../http/schemas.js';
import { EQUIPMENT_TYPES } from '../lib/labels.js';

const manager = { config: { roles: ['manager'] as Role[] } };

const TemplateParams = z.object({ id: z.coerce.number().int().positive() });
const ItemParams = TemplateParams.extend({ item_id: z.coerce.number().int().positive() });

const UpdateTemplate = z.object({
  version,
  name: requiredText(LIMITS.name, 'Введите название').optional(),
  is_active: z.boolean().optional(),
});

const ItemBody = z
  .object({
    version, // версия шаблона: правки пунктов сериализуются через строку шаблона
    section_name: optionalText(LIMITS.name),
    check_text: requiredText(LIMITS.text, 'Введите текст проверки'),
    target_type: z.enum(['system', 'equipment'], { error: 'Укажите, к чему применяется проверка' }),
    equipment_type_filter: z
      .array(z.string().refine((v) => EQUIPMENT_TYPES.includes(v), 'Неизвестный тип оборудования'))
      .nullish()
      .transform((v) => (v && v.length > 0 ? [...new Set(v)] : null)),
    is_required: z.boolean().default(true),
  })
  .refine((v) => v.target_type === 'equipment' || v.equipment_type_filter === null, {
    path: ['equipment_type_filter'],
    message: 'Фильтр типов задаётся только для пунктов по оборудованию',
  });

const OrderBody = z.object({ version, item_ids: z.array(z.number().int().positive()).min(1, 'Список пунктов пуст') });
const DeleteBody = z.object({ version });

async function lockTemplate(trx: Trx, id: number, expectedVersion: number) {
  const tpl = await trx.selectFrom('checklist_template').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  return assertVersion(tpl, expectedVersion, 'Шаблон');
}

/** Отметка изменения шаблона: повышает version, чтобы параллельные правки получили 409. */
async function touchTemplate(trx: Trx, id: number) {
  return trx.updateTable('checklist_template').set({ name: sql`name` }).where('id', '=', id).returning('version').executeTakeFirstOrThrow();
}

async function activeRegulationsCount(trx: Trx, templateId: number): Promise<number> {
  const { n } = await trx
    .selectFrom('maintenance_regulation')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('template_id', '=', templateId)
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow();
  return n;
}

export async function templateRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/templates', manager, async () => {
    const items = await db
      .selectFrom('checklist_template as t')
      .selectAll('t')
      .select((eb) => eb.selectFrom('template_item as i').select(sql<number>`count(*)`.as('n')).whereRef('i.template_id', '=', 't.id').as('items_count'))
      .orderBy('t.id')
      .execute();
    return { items };
  });

  app.get('/templates/:id', manager, async (req) => {
    const { id } = parse(TemplateParams, req.params);
    const tpl = requireRow(await db.selectFrom('checklist_template').selectAll().where('id', '=', id).executeTakeFirst(), 'Шаблон не найден');
    const items = await db.selectFrom('template_item').selectAll().where('template_id', '=', id).orderBy('position').execute();
    const active = await db.transaction().execute((trx) => activeRegulationsCount(trx, id));
    return { ...tpl, items, active_regulations_count: active };
  });

  app.patch('/templates/:id', manager, async (req) => {
    const { id } = parse(TemplateParams, req.params);
    const body = parse(UpdateTemplate, req.body);
    return db.transaction().execute(async (trx) => {
      const tpl = await lockTemplate(trx, id, body.version);
      if (body.is_active === false && tpl.is_active && (await activeRegulationsCount(trx, id)) > 0) {
        throw conflict('template_in_use', 'Шаблон используется действующими регламентами: сначала приостановите их');
      }
      return trx
        .updateTable('checklist_template')
        .set({ name: body.name ?? tpl.name, is_active: body.is_active ?? tpl.is_active })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  });

  app.post('/templates/:id/items', manager, async (req, reply) => {
    const { id } = parse(TemplateParams, req.params);
    const { version: v, equipment_type_filter, ...fields } = parse(ItemBody, req.body);
    const result = await db.transaction().execute(async (trx) => {
      await lockTemplate(trx, id, v);
      const { max } = await trx
        .selectFrom('template_item')
        .select((eb) => eb.fn.coalesce(eb.fn.max('position'), eb.lit(0)).as('max'))
        .where('template_id', '=', id)
        .executeTakeFirstOrThrow();
      const item = await trx
        .insertInto('template_item')
        .values({ ...fields, template_id: id, position: Number(max) + 1, equipment_type_filter: equipment_type_filter && JSON.stringify(equipment_type_filter) })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { item, template_version: (await touchTemplate(trx, id)).version };
    });
    reply.status(201);
    return result;
  });

  app.patch('/templates/:id/items/:item_id', manager, async (req) => {
    const { id, item_id } = parse(ItemParams, req.params);
    const { version: v, equipment_type_filter, ...fields } = parse(ItemBody, req.body);
    return db.transaction().execute(async (trx) => {
      await lockTemplate(trx, id, v);
      const item = await trx
        .updateTable('template_item')
        .set({ ...fields, equipment_type_filter: equipment_type_filter && JSON.stringify(equipment_type_filter) })
        .where('id', '=', item_id)
        .where('template_id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return { item: requireRow(item, 'Пункт не найден'), template_version: (await touchTemplate(trx, id)).version };
    });
  });

  app.delete('/templates/:id/items/:item_id', manager, async (req) => {
    const { id, item_id } = parse(ItemParams, req.params);
    const body = parse(DeleteBody, req.body ?? {});
    return db.transaction().execute(async (trx) => {
      await lockTemplate(trx, id, body.version);
      const { n } = await trx.selectFrom('template_item').select((eb) => eb.fn.countAll<number>().as('n')).where('template_id', '=', id).executeTakeFirstOrThrow();
      if (n <= 1 && (await activeRegulationsCount(trx, id)) > 0) {
        throw conflict('last_item', 'Нельзя удалить последний пункт: шаблон используется действующими регламентами');
      }
      const res = await trx.deleteFrom('template_item').where('id', '=', item_id).where('template_id', '=', id).executeTakeFirst();
      if (Number(res.numDeletedRows) === 0) requireRow(undefined, 'Пункт не найден');
      // позиции подтягиваются без пропусков
      await renumber(trx, id, (await trx.selectFrom('template_item').select('id').where('template_id', '=', id).orderBy('position').execute()).map((r) => r.id));
      return { template_version: (await touchTemplate(trx, id)).version };
    });
  });

  app.put('/templates/:id/items/order', manager, async (req) => {
    const { id } = parse(TemplateParams, req.params);
    const body = parse(OrderBody, req.body);
    return db.transaction().execute(async (trx) => {
      await lockTemplate(trx, id, body.version);
      const current = await trx.selectFrom('template_item').select('id').where('template_id', '=', id).execute();
      const currentIds = new Set(current.map((r) => r.id));
      const given = new Set(body.item_ids);
      if (given.size !== body.item_ids.length || given.size !== currentIds.size || body.item_ids.some((i) => !currentIds.has(i))) {
        throw badRequest('Список должен содержать все пункты шаблона ровно по одному разу', { item_ids: 'Неверный набор пунктов' });
      }
      await renumber(trx, id, body.item_ids);
      return { template_version: (await touchTemplate(trx, id)).version };
    });
  });
}

/**
 * Переписывает позиции 1..N в заданном порядке. Уникальность (template_id, position)
 * не отложенная, поэтому сначала позиции сдвигаются за пределы текущих.
 */
async function renumber(trx: Trx, templateId: number, orderedIds: number[]) {
  if (orderedIds.length === 0) return;
  const offset = 100_000;
  await trx.updateTable('template_item').set({ position: sql`position + ${offset}` }).where('template_id', '=', templateId).execute();
  for (const [i, itemId] of orderedIds.entries()) {
    await trx.updateTable('template_item').set({ position: i + 1 }).where('id', '=', itemId).execute();
  }
}
