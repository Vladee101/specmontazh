// UC 04–09: объекты, системы, оборудование.
// Удаление — только пустой карточки (иначе FK даёт 409), архив — после завершения
// открытых заданий, с приостановкой регламентов. Инженер читает только карточки своих заданий.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type ExpressionBuilder } from 'kysely';
import { z } from 'zod';
import type { Trx } from '../db/index.js';
import { assertVersion, requireRow } from '../db/helpers.js';
import type { Database, Role } from '../db/types.js';
import { currentUser } from '../http/auth.js';
import { badRequest, conflict, forbidden, parse } from '../http/errors.js';
import {
  boolQuery,
  idParam,
  isoDate,
  LIMITS,
  optionalDate,
  optionalId,
  optionalText,
  pageResult,
  pagination,
  requiredText,
  systemType,
  version,
} from '../http/schemas.js';
import { EQUIPMENT_TYPES, OPEN_TASK_STATUSES } from '../lib/labels.js';

const manager = { config: { roles: ['manager'] as Role[] } };
const readers = { config: { roles: ['manager', 'engineer'] as Role[] } };

const equipmentType = z
  .string({ error: 'Выберите тип оборудования' })
  .trim()
  .refine((v) => EQUIPMENT_TYPES.includes(v), 'Неизвестный тип оборудования');

const ObjectFields = {
  name: requiredText(LIMITS.name, 'Введите название'),
  customer_name: requiredText(LIMITS.name, 'Введите заказчика'),
  address: requiredText(LIMITS.address, 'Введите адрес'),
  contact_name: optionalText(LIMITS.name),
  contact_phone: optionalText(LIMITS.phone),
  notes: optionalText(LIMITS.text),
};
const CreateObject = z.object(ObjectFields);
const UpdateObject = z.object({ version, ...ObjectFields }).partial().required({ version: true });

const SystemFields = {
  name: requiredText(LIMITS.name, 'Введите название'),
  system_type: systemType,
  location: optionalText(LIMITS.name),
  description: optionalText(LIMITS.text),
};
const CreateSystem = z.object({ object_id: z.number().int().positive(), ...SystemFields });
const UpdateSystem = z.object({ version, ...SystemFields }).partial().required({ version: true });

const EquipmentFields = {
  name: requiredText(LIMITS.name, 'Введите название'),
  equipment_type: equipmentType,
  model: optionalText(LIMITS.name),
  serial_number: optionalText(LIMITS.name),
  location: optionalText(LIMITS.name),
  installed_on: optionalDate,
};
const CreateEquipment = z.object({ system_id: z.number().int().positive(), ...EquipmentFields });
const UpdateEquipment = z.object({ version, ...EquipmentFields }).partial().required({ version: true });
const Decommission = z.object({
  version,
  decommissioned_on: isoDate,
  reason: requiredText(LIMITS.text, 'Укажите причину вывода'),
});
const VersionOnly = z.object({ version });

/** Системы, по которым у инженера есть назначенные ему задания. */
function engineerSystems(eb: ExpressionBuilder<Database, any>, engineerId: number) {
  return eb.selectFrom('maintenance_task as et').select('et.system_id').where('et.assigned_engineer_id', '=', engineerId);
}

function engineerId(req: FastifyRequest): number | null {
  const user = currentUser(req);
  return user.role === 'engineer' ? user.id : null;
}

async function openTasksIn(trx: Trx, filter: { objectId?: number; systemId?: number; equipmentId?: number }) {
  let q = trx
    .selectFrom('maintenance_task as t')
    .innerJoin('low_current_system as s', 's.id', 't.system_id')
    .select(['t.id', 't.task_number', 't.status'])
    .where('t.status', 'in', OPEN_TASK_STATUSES);
  if (filter.objectId) q = q.where('s.object_id', '=', filter.objectId);
  if (filter.systemId) q = q.where('t.system_id', '=', filter.systemId);
  if (filter.equipmentId) {
    q = q.where((eb) =>
      eb.exists(eb.selectFrom('task_equipment as te').select('te.id').whereRef('te.task_id', '=', 't.id').where('te.equipment_id', '=', filter.equipmentId!)),
    );
  }
  return q.orderBy('t.current_due_date').execute();
}

function taskList(tasks: { task_number: string }[]) {
  return tasks.map((t) => t.task_number).join(', ');
}

export async function catalogRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ---------- Объекты ----------

  app.get('/objects', readers, async (req) => {
    const q = parse(pagination.extend({ q: z.string().trim().optional(), archived: boolQuery }), req.query);
    const eng = engineerId(req);
    let query = db.selectFrom('service_object as o').where('o.is_archived', '=', q.archived ?? false);
    if (q.q) {
      const like = `%${q.q}%`;
      query = query.where((eb) => eb.or([eb('o.name', 'ilike', like), eb('o.address', 'ilike', like), eb('o.customer_name', 'ilike', like)]));
    }
    if (eng) {
      query = query.where((eb) =>
        eb.exists(eb.selectFrom('low_current_system as es').select('es.id').whereRef('es.object_id', '=', 'o.id').where('es.id', 'in', engineerSystems(eb, eng))),
      );
    }
    const { total } = await query.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
    const items = await query
      .selectAll('o')
      .select((eb) =>
        eb.selectFrom('low_current_system as s').select(sql<number>`count(*)`.as('n')).whereRef('s.object_id', '=', 'o.id').where('s.is_archived', '=', false).as('systems_count'),
      )
      .orderBy('o.name')
      .limit(q.page_size)
      .offset((q.page - 1) * q.page_size)
      .execute();
    return pageResult(items, total, q.page, q.page_size);
  });

  app.get('/objects/:id', readers, async (req) => {
    const { id } = parse(idParam, req.params);
    const eng = engineerId(req);
    const object = requireRow(await db.selectFrom('service_object').selectAll().where('id', '=', id).executeTakeFirst(), 'Объект не найден');
    let systems = db
      .selectFrom('low_current_system as s')
      .selectAll('s')
      .select((eb) =>
        eb.selectFrom('equipment as e').select(sql<number>`count(*)`.as('n')).whereRef('e.system_id', '=', 's.id').where('e.lifecycle_status', '=', 'active').as('equipment_count'),
      )
      .where('s.object_id', '=', id);
    if (eng) systems = systems.where((eb) => eb('s.id', 'in', engineerSystems(eb, eng)));
    const list = await systems.orderBy('s.name').execute();
    if (eng && list.length === 0) throw forbidden('Нет доступа к объекту');
    return { ...object, systems: list };
  });

  app.post('/objects', manager, async (req, reply) => {
    const body = parse(CreateObject, req.body);
    const object = await db.insertInto('service_object').values({ ...body, created_by_id: currentUser(req).id }).returningAll().executeTakeFirstOrThrow();
    reply.status(201);
    return object;
  });

  app.patch('/objects/:id', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const { version: v, ...fields } = parse(UpdateObject, req.body);
    return db.transaction().execute(async (trx) => {
      assertVersion(await trx.selectFrom('service_object').select('version').where('id', '=', id).forUpdate().executeTakeFirst(), v, 'Объект');
      return trx.updateTable('service_object').set(fields).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    });
  });

  app.delete('/objects/:id', manager, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const res = await db.deleteFrom('service_object').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) requireRow(undefined, 'Объект не найден');
    reply.status(204);
  });

  // UC 05: архив. Открытые задания блокируют; регламенты объекта приостанавливаются; повтор безопасен.
  app.post('/objects/:id/archive', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(VersionOnly, req.body);
    return db.transaction().execute(async (trx) => {
      const object = requireRow(await trx.selectFrom('service_object').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), 'Объект не найден');
      if (object.is_archived) return object;
      assertVersion(object, body.version);
      const open = await openTasksIn(trx, { objectId: id });
      if (open.length > 0) {
        throw conflict('open_tasks', `Архивирование невозможно: есть незавершённые задания ${taskList(open)}. Сначала примите или отмените их.`, { tasks: open });
      }
      const systemIds = trx.selectFrom('low_current_system').select('id').where('object_id', '=', id);
      await trx
        .updateTable('maintenance_regulation')
        .set({ status: 'paused', paused_at: sql`now()` })
        .where('status', '=', 'active')
        .where('system_id', 'in', systemIds)
        .execute();
      return trx.updateTable('service_object').set({ is_archived: true, archived_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    });
  });

  // ---------- Системы ----------

  app.get('/systems', readers, async (req) => {
    const q = parse(z.object({ object_id: optionalId, system_type: systemType.optional(), archived: boolQuery }), req.query);
    const eng = engineerId(req);
    let query = db
      .selectFrom('low_current_system as s')
      .innerJoin('service_object as o', 'o.id', 's.object_id')
      .selectAll('s')
      .select(['o.name as object_name'])
      .select((eb) =>
        eb.selectFrom('equipment as e').select(sql<number>`count(*)`.as('n')).whereRef('e.system_id', '=', 's.id').where('e.lifecycle_status', '=', 'active').as('equipment_count'),
      );
    if (q.object_id) query = query.where('s.object_id', '=', q.object_id);
    if (q.system_type) query = query.where('s.system_type', '=', q.system_type as never);
    if (q.archived !== undefined) query = query.where('s.is_archived', '=', q.archived);
    if (eng) query = query.where((eb) => eb('s.id', 'in', engineerSystems(eb, eng)));
    return { items: await query.orderBy('o.name').orderBy('s.name').execute() };
  });

  app.get('/systems/:id', readers, async (req) => {
    const { id } = parse(idParam, req.params);
    const eng = engineerId(req);
    const system = requireRow(
      await db
        .selectFrom('low_current_system as s')
        .innerJoin('service_object as o', 'o.id', 's.object_id')
        .selectAll('s')
        .select(['o.name as object_name', 'o.is_archived as object_archived'])
        .where('s.id', '=', id)
        .executeTakeFirst(),
      'Система не найдена',
    );
    if (eng) {
      const own = await db.selectFrom('maintenance_task').select('id').where('system_id', '=', id).where('assigned_engineer_id', '=', eng).executeTakeFirst();
      if (!own) throw forbidden('Нет доступа к системе');
    }
    const equipment = await db.selectFrom('equipment').selectAll().where('system_id', '=', id).orderBy('lifecycle_status').orderBy('name').execute();
    const regulations = eng
      ? []
      : await db.selectFrom('maintenance_regulation').selectAll().where('system_id', '=', id).orderBy('name').execute();
    const has = await db
      .selectNoFrom((eb) => [
        eb.exists(eb.selectFrom('equipment').select('id').where('system_id', '=', id)).as('equipment'),
        eb.exists(eb.selectFrom('maintenance_regulation').select('id').where('system_id', '=', id)).as('regulations'),
        eb.exists(eb.selectFrom('maintenance_task').select('id').where('system_id', '=', id)).as('tasks'),
      ])
      .executeTakeFirstOrThrow();
    return { ...system, equipment, regulations, type_locked: Boolean(has.equipment || has.regulations || has.tasks) };
  });

  app.post('/systems', manager, async (req, reply) => {
    const body = parse(CreateSystem, req.body);
    const system = await db.transaction().execute(async (trx) => {
      const object = requireRow(await trx.selectFrom('service_object').select(['id', 'is_archived']).where('id', '=', body.object_id).forShare().executeTakeFirst(), 'Объект не найден');
      if (object.is_archived) throw conflict('archived', 'Объект в архиве: добавлять системы нельзя');
      return trx.insertInto('low_current_system').values({ ...body, system_type: body.system_type as never }).returningAll().executeTakeFirstOrThrow();
    });
    reply.status(201);
    return system;
  });

  app.patch('/systems/:id', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const { version: v, ...fields } = parse(UpdateSystem, req.body);
    return db.transaction().execute(async (trx) => {
      assertVersion(await trx.selectFrom('low_current_system').select('version').where('id', '=', id).forUpdate().executeTakeFirst(), v, 'Система');
      // смену типа при наличии оборудования, регламентов или заданий запрещает триггер БД
      return trx
        .updateTable('low_current_system')
        .set({ ...fields, system_type: fields.system_type as never })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  });

  app.delete('/systems/:id', manager, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const res = await db.deleteFrom('low_current_system').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) requireRow(undefined, 'Система не найдена');
    reply.status(204);
  });

  // UC 07: архив системы.
  app.post('/systems/:id/archive', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(VersionOnly, req.body);
    return db.transaction().execute(async (trx) => {
      const system = requireRow(await trx.selectFrom('low_current_system').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), 'Система не найдена');
      if (system.is_archived) return system;
      assertVersion(system, body.version);
      const open = await openTasksIn(trx, { systemId: id });
      if (open.length > 0) {
        throw conflict('open_tasks', `Архивирование невозможно: есть незавершённые задания ${taskList(open)}. Сначала примите или отмените их.`, { tasks: open });
      }
      await trx.updateTable('maintenance_regulation').set({ status: 'paused', paused_at: sql`now()` }).where('status', '=', 'active').where('system_id', '=', id).execute();
      return trx.updateTable('low_current_system').set({ is_archived: true, archived_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    });
  });

  // ---------- Оборудование ----------

  app.get('/equipment-types', readers, async () => ({ items: EQUIPMENT_TYPES }));

  app.get('/equipment', readers, async (req) => {
    const q = parse(z.object({ system_id: optionalId, status: z.enum(['active', 'decommissioned']).optional() }), req.query);
    if (!q.system_id) throw badRequest('Укажите систему', { system_id: 'Укажите систему' });
    const eng = engineerId(req);
    let query = db.selectFrom('equipment').selectAll().where('system_id', '=', q.system_id);
    if (q.status) query = query.where('lifecycle_status', '=', q.status);
    if (eng) query = query.where((eb) => eb('system_id', 'in', engineerSystems(eb, eng)));
    return { items: await query.orderBy('lifecycle_status').orderBy('name').execute() };
  });

  app.post('/equipment', manager, async (req, reply) => {
    const body = parse(CreateEquipment, req.body);
    const equipment = await db.transaction().execute(async (trx) => {
      const system = requireRow(await trx.selectFrom('low_current_system').select(['id', 'is_archived']).where('id', '=', body.system_id).forShare().executeTakeFirst(), 'Система не найдена');
      if (system.is_archived) throw conflict('archived', 'Система в архиве: добавлять оборудование нельзя');
      return trx.insertInto('equipment').values(body).returningAll().executeTakeFirstOrThrow();
    });
    reply.status(201);
    return equipment;
  });

  // UC 08: новое имя видно в старых заданиях (задание читает имя из карточки), результаты не меняются.
  app.patch('/equipment/:id', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const { version: v, ...fields } = parse(UpdateEquipment, req.body);
    return db.transaction().execute(async (trx) => {
      assertVersion(await trx.selectFrom('equipment').select('version').where('id', '=', id).forUpdate().executeTakeFirst(), v, 'Оборудование');
      return trx.updateTable('equipment').set(fields).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    });
  });

  // UC 09: удаление запрещено при истории ТО (FK task_equipment → 409).
  app.delete('/equipment/:id', manager, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const res = await db.deleteFrom('equipment').where('id', '=', id).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) requireRow(undefined, 'Оборудование не найдено');
    reply.status(204);
  });

  app.post('/equipment/:id/decommission', manager, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(Decommission, req.body);
    return db.transaction().execute(async (trx) => {
      const eq = assertVersion(await trx.selectFrom('equipment').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), body.version, 'Оборудование');
      if (eq.lifecycle_status === 'decommissioned') throw conflict('already_decommissioned', 'Оборудование уже выведено из эксплуатации');
      const open = await openTasksIn(trx, { equipmentId: id });
      if (open.length > 0) {
        throw conflict('open_tasks', `Вывод невозможен: устройство входит в незавершённое задание ${taskList(open)}. Сначала завершите или отмените задание.`, { tasks: open });
      }
      return trx
        .updateTable('equipment')
        .set({ lifecycle_status: 'decommissioned', decommissioned_on: body.decommissioned_on, decommission_reason: body.reason })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  });
}
